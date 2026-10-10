import type {
  OnlineCheckout,
  OrderPaymentAction,
  OrderPaymentRecord,
  OrderPaymentState,
  PaymentMethod,
  SessionUser,
} from "@/lib/contracts";
import { all, get, newId, nowIso, run, tx } from "../db";
import { AppError, conflict, notFound, requireRole } from "../errors";
import {
  checkRazorpayConfig,
  getGateway,
  isValidCheckoutSignature,
  payableOnline,
  paymentMismatch,
  requireRazorpay,
  type GatewayPayment,
} from "../razorpay";
import { settlePendingFor } from "./finance";
import { memberOrder } from "./merch";

/**
 * Paying for merchandise online.
 *
 * An order line is paid when its pending ledger entry is settled. That is the
 * one place payment is recorded, whether a committee member takes cash or
 * Razorpay confirms a payment, so the two can never both pay the same line.
 *
 * 1. The member asks to pay an order. The amount is the sum of that order's
 *    unpaid lines, read from the database; nothing the browser sends is used.
 *    The server creates a Razorpay order for it and remembers which lines.
 * 2. The browser pays through Razorpay Checkout.
 * 3. A payment counts only once the server has verified it: the Checkout
 *    signature plus the payment fetched from Razorpay, or a signed webhook, or
 *    a lookup of the order at Razorpay. The order, amount, currency and
 *    `captured` status must match what the server stored.
 * 4. A verified payment is recorded once and settles its lines, in one
 *    transaction. It changes nothing about hand-over, and nothing about memberships.
 */

type Via = "checkout" | "webhook" | "lookup";

interface PaymentRow {
  id: string;
  member_id: string;
  order_code: string;
  amount_cents: number;
  currency: string;
  status: OrderPaymentRecord["status"];
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  payment_method: string | null;
  paid_at: string | null;
  applied_cents: number | null;
  failure_reason: string | null;
  review_reason: string | null;
  resolution_note: string | null;
  created_at: string;
  member_name: string;
  member_no: string;
  member_email: string;
  member_phone: string | null;
  resolved_by_name: string | null;
}

const SELECT = `
  SELECT p.*, m.name AS member_name, m.member_no AS member_no, m.email AS member_email, m.phone AS member_phone,
         u.name AS resolved_by_name
  FROM order_payments p
  JOIN members m ON m.id = p.member_id
  LEFT JOIN users u ON u.id = p.resolved_by`;

function load(id: string): PaymentRow {
  const row = get<PaymentRow>(`${SELECT} WHERE p.id = ?`, id);
  if (!row) throw notFound("Payment");
  return row;
}

const isOpen = (row: PaymentRow) => row.status === "pending" || row.status === "failed";

/** The attempt that can still be paid for this order, if there is one. */
const openAttempt = (orderCode: string) =>
  get<PaymentRow>(`${SELECT} WHERE p.order_code = ? AND p.status IN ('pending','failed')`, orderCode);

const linesOf = (paymentId: string) =>
  all<{ order_id: string; amount_cents: number }>(
    "SELECT order_id, amount_cents FROM order_payment_lines WHERE payment_id = ? ORDER BY order_id",
    paymentId,
  );

const ledgerMethod = (method: string | null): PaymentMethod =>
  method === "upi" ? "upi" : method === "card" ? "card" : method === "netbanking" ? "bank" : "other";

// --- recording a verified payment -----------------------------------------------

/**
 * Writes a verified, captured payment onto its attempt and settles the lines
 * it was for, in one transaction. Runs once per attempt: a second call finds
 * the payment already recorded and does nothing, so repeated callbacks and
 * webhooks cannot settle anything twice.
 *
 * A line that was paid by hand or cancelled in the meantime is skipped; the
 * money for it is owed back, and the attempt is left for a reviewer.
 * Callers must have checked the payment against the attempt first.
 */
function recordPayment(id: string, payment: GatewayPayment, via: Via): boolean {
  return tx(() => {
    const row = load(id);
    if (row.razorpay_payment_id) {
      if (row.razorpay_payment_id !== payment.id) {
        // Razorpay allows one captured payment per order. If a second ever arrives, keep the evidence.
        run(
          "UPDATE order_payments SET status = 'needs_review', review_reason = ?, updated_at = ? WHERE id = ? AND status = 'paid'",
          `A second payment (${payment.id}) was captured for this order. Refund it in Razorpay.`,
          nowIso(),
          id,
        );
      }
      return false;
    }

    let applied = 0;
    for (const line of linesOf(id)) {
      const order = get<{ status: string; payment_status: string; total_cents: number }>(
        "SELECT status, payment_status, total_cents FROM orders WHERE id = ?",
        line.order_id,
      );
      const stillOwed =
        order?.status !== "cancelled" && order?.payment_status === "pending" && order.total_cents === line.amount_cents;
      // The same call a committee member's "mark paid" makes: it settles the ledger entry and marks the line paid.
      if (stillOwed && settlePendingFor({ orderId: line.order_id }, ledgerMethod(payment.method), `Razorpay ${payment.id}`)) {
        applied += line.amount_cents;
      }
    }

    const excess = row.amount_cents - applied;
    const ts = nowIso();
    const updated = run(
      `UPDATE order_payments
       SET status = ?, razorpay_payment_id = ?, payment_method = ?, paid_at = ?, verified_via = ?,
           applied_cents = ?, review_reason = ?, failure_reason = NULL, updated_at = ?
       WHERE id = ? AND razorpay_payment_id IS NULL`,
      excess === 0 ? "paid" : "needs_review",
      payment.id,
      payment.method,
      ts,
      via,
      applied,
      excess === 0
        ? null
        : "Part of this payment was for items already paid or cancelled. Refund the difference in Razorpay.",
      ts,
      id,
    );
    if (updated.changes !== 1) throw conflict("already_recorded", "This payment was already recorded.");
    return true;
  });
}

function markFailed(id: string, reason: string | null): boolean {
  const ts = nowIso();
  return (
    run(
      `UPDATE order_payments SET status = 'failed', failure_reason = ?, failed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending','failed')`,
      (reason ?? "The payment did not go through.").slice(0, 200),
      ts,
      ts,
      id,
    ).changes === 1
  );
}

const expected = (row: PaymentRow) => ({
  orderId: row.razorpay_order_id,
  amountCents: row.amount_cents,
  currency: row.currency,
});

type Resolution = "settled" | "processing" | "failed" | "none";

/**
 * Acts on a payment that came from Razorpay's API. Only a captured payment
 * that matches the stored attempt is recorded. One that is only authorised is
 * captured for the exact amount first; if that does not succeed the order
 * stays unpaid.
 */
async function resolvePayment(row: PaymentRow, fetched: GatewayPayment, via: Via): Promise<Resolution> {
  let payment = fetched;
  const reject = (what: string) => {
    console.error(`[order-payments] payment ${payment.id} does not match order ${row.order_code}: ${what}`);
    return new AppError("payment_mismatch", "That payment does not match this order.", 409);
  };
  let bad = paymentMismatch(expected(row), payment);
  if (bad) throw reject(bad);

  if (payment.status === "authorized") {
    try {
      payment = await getGateway().capturePayment(payment.id, row.amount_cents, row.currency);
    } catch {
      return "processing";
    }
    bad = paymentMismatch(expected(row), payment);
    if (bad) throw reject(bad);
  }
  if (payment.status === "captured") {
    recordPayment(row.id, payment, via);
    return "settled";
  }
  if (payment.status === "failed" || payment.status === "refunded") {
    markFailed(row.id, payment.status === "refunded" ? "The payment was refunded." : payment.errorDescription);
    return "failed";
  }
  return "processing";
}

/** Asks Razorpay whether the attempt's order was paid, for when neither the browser nor a webhook said so. */
async function syncWithProvider(row: PaymentRow): Promise<Resolution> {
  if (row.razorpay_payment_id) return "settled";
  const payments = await getGateway().listOrderPayments(row.razorpay_order_id);
  const paid = payments.find((p) => p.status === "captured") ?? payments.find((p) => p.status === "authorized");
  return paid ? resolvePayment(row, paid, "lookup") : "none";
}

// --- the member's actions --------------------------------------------------------

function toCheckout(row: PaymentRow): OnlineCheckout | null {
  const check = checkRazorpayConfig();
  if (!isOpen(row) || !check.ok) return null;
  return {
    keyId: check.config.keyId,
    orderId: row.razorpay_order_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    name: row.member_name,
    email: row.member_email,
    phone: row.member_phone,
  };
}

function stateOf(memberId: string, orderCode: string, processing = false): OrderPaymentState {
  const { order } = memberOrder(memberId, orderCode);
  const open = openAttempt(order.code);
  // An attempt is only worth offering while it still matches what is owed.
  const current = open && order.unpaidCents === open.amount_cents ? open : undefined;
  return {
    order,
    checkout: current ? toCheckout(current) : null,
    processing,
    failureReason: current?.status === "failed" ? current.failure_reason : null,
  };
}

/** Whether an attempt covers exactly these lines at these amounts. Compared by id, so order does not matter. */
const sameLines = (owed: { orderId: string; amountCents: number }[], paymentId: string) => {
  const stored = new Map(linesOf(paymentId).map((line) => [line.order_id, line.amount_cents]));
  return stored.size === owed.length && owed.every((line) => stored.get(line.orderId) === line.amountCents);
};

/** Opens (or reopens) the payment for everything still owed on one of the member's orders. */
async function startPayment(memberId: string, orderCode: string): Promise<OrderPaymentState> {
  requireRazorpay();
  // Loads the order by the session's member; someone else's order is "not found".
  let { order, owed } = memberOrder(memberId, orderCode);

  // An earlier attempt may have been paid without this server hearing of it.
  const earlier = openAttempt(order.code);
  if (earlier) {
    const outcome = await syncWithProvider(earlier);
    if (outcome === "settled") return stateOf(memberId, order.code);
    if (outcome === "processing") return stateOf(memberId, order.code, true);
    ({ order, owed } = memberOrder(memberId, orderCode));
  }

  const amountCents = owed.reduce((sum, line) => sum + line.amountCents, 0);
  if (amountCents === 0) throw conflict("nothing_to_pay", "This order has nothing left to pay.");
  if (!payableOnline(amountCents)) {
    throw new AppError("not_payable_online", "This order cannot be paid online. Pay the committee when you collect it.", 409);
  }
  if (get("SELECT 1 FROM order_payments WHERE order_code = ? AND status = 'needs_review'", order.code)) {
    throw conflict("payment_under_review", "An earlier payment for this order is being checked by the committee.");
  }

  // The same amount for the same lines: carry on with the order Razorpay already has.
  const reusable = openAttempt(order.code);
  if (reusable && reusable.amount_cents === amountCents && sameLines(owed, reusable.id)) {
    return stateOf(memberId, order.code);
  }

  const currency = process.env.NEXT_PUBLIC_CURRENCY ?? "INR";
  const created = await getGateway().createOrder({
    amountCents,
    currency,
    receipt: order.code,
    notes: { purpose: "merchandise", order: order.code },
  });
  if (created.amountCents !== amountCents || created.currency !== currency) {
    console.error(`[order-payments] order for ${order.code} came back with a different amount or currency`);
    throw new AppError("payment_provider_unavailable", "The payment could not be started. Try again.", 502);
  }

  tx(() => {
    // What is owed may have changed while Razorpay was being asked.
    const now = memberOrder(memberId, orderCode);
    const stillSame =
      now.owed.length === owed.length &&
      now.owed.every((line, i) => line.orderId === owed[i].orderId && line.amountCents === owed[i].amountCents);
    if (!stillSame) throw conflict("order_changed", "This order changed while the payment was starting. Try again.");

    // Two clicks at once: the first to get here wins and the other uses its attempt.
    const winner = openAttempt(order.code);
    if (winner && winner.amount_cents === amountCents && sameLines(owed, winner.id)) return;

    const ts = nowIso();
    run(
      "UPDATE order_payments SET status = 'superseded', updated_at = ? WHERE order_code = ? AND status IN ('pending','failed')",
      ts,
      order.code,
    );
    const id = newId("opy");
    run(
      `INSERT INTO order_payments
         (id, member_id, order_code, amount_cents, currency, status, razorpay_order_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      id,
      memberId,
      order.code,
      amountCents,
      currency,
      created.id,
      ts,
      ts,
    );
    for (const line of owed) {
      run(
        "INSERT INTO order_payment_lines (payment_id, order_id, amount_cents) VALUES (?, ?, ?)",
        id,
        line.orderId,
        line.amountCents,
      );
    }
  });
  return stateOf(memberId, order.code);
}

/**
 * Everything a signed-in member may do about paying one of their orders.
 * `memberId` comes from the session. Every action starts by loading the order
 * for that member, so no action can reach another member's order.
 */
export async function orderPaymentAction(
  memberId: string,
  orderCode: string,
  action: OrderPaymentAction,
): Promise<OrderPaymentState> {
  if (action.action === "start") return startPayment(memberId, orderCode);

  const { order } = memberOrder(memberId, orderCode);
  let processing = false;

  if (action.action === "confirm") {
    const config = requireRazorpay();
    // The attempt is found through this member's order, never from the id in the request alone.
    const attempt = get<PaymentRow>(
      `${SELECT} WHERE p.order_code = ? AND p.razorpay_order_id = ?`,
      order.code,
      action.razorpayOrderId,
    );
    if (
      !attempt ||
      !isValidCheckoutSignature(config, attempt.razorpay_order_id, action.razorpayPaymentId, action.razorpaySignature)
    ) {
      throw new AppError("payment_unverified", "That payment could not be verified. Nothing has been marked paid.", 400);
    }
    // A webhook may have recorded it already; then there is nothing left to verify.
    if (!attempt.razorpay_payment_id) {
      const payment = await getGateway().fetchPayment(action.razorpayPaymentId);
      processing = (await resolvePayment(attempt, payment, "checkout")) === "processing";
    }
  } else if (action.action === "check") {
    const attempt = openAttempt(order.code);
    if (attempt && checkRazorpayConfig().ok) {
      try {
        processing = (await syncWithProvider(attempt)) === "processing";
      } catch (error) {
        // Razorpay being unreachable must not hide what is already known.
        if (!(error instanceof AppError) || error.code === "payment_mismatch") throw error;
      }
    }
  } else {
    // Only a note for the member's own screen. A failure reported by the browser decides nothing.
    const attempt = openAttempt(order.code);
    if (attempt) markFailed(attempt.id, action.reason);
  }
  return stateOf(memberId, order.code, processing);
}

// --- webhooks ------------------------------------------------------------------

/**
 * The merchandise half of the Razorpay webhook, called by the webhook handler
 * (inside its transaction, after it has verified the signature and found that
 * the event is not for a membership). Returns null when the payment's order is
 * not a merchandise payment either.
 */
export function handleOrderPaymentEvent(type: string, payment: GatewayPayment): string | null {
  const row = payment.orderId
    ? get<PaymentRow>(`${SELECT} WHERE p.razorpay_order_id = ?`, payment.orderId)
    : undefined;
  if (!row) return null;

  if (type === "payment.captured" || type === "order.paid") {
    const bad = paymentMismatch(expected(row), payment);
    if (bad) {
      console.error(`[order-payments] webhook payment ${payment.id} does not match order ${row.order_code}: ${bad}`);
      return `rejected_${bad}_mismatch`;
    }
    if (payment.status !== "captured") return "ignored_not_captured";
    return recordPayment(row.id, payment, "webhook") ? "order_paid" : "already_recorded";
  }
  if (type === "payment.failed") {
    return markFailed(row.id, payment.errorDescription) ? "marked_failed" : "ignored_already_paid";
  }
  return "ignored";
}

// --- the committee's side ------------------------------------------------------

const toRecord = (r: PaymentRow): OrderPaymentRecord => ({
  id: r.id,
  orderCode: r.order_code,
  memberName: r.member_name,
  memberNo: r.member_no,
  amountCents: r.amount_cents,
  appliedCents: r.applied_cents,
  status: r.status,
  razorpayOrderId: r.razorpay_order_id,
  razorpayPaymentId: r.razorpay_payment_id,
  paymentMethod: r.payment_method,
  paidAt: r.paid_at,
  reviewReason: r.review_reason,
  resolvedByName: r.resolved_by_name,
  resolutionNote: r.resolution_note,
  createdAt: r.created_at,
});

/** Online merchandise payments that reached Razorpay's "paid", those needing a refund first. */
export function listOrderPayments(actor: SessionUser | null): OrderPaymentRecord[] {
  requireRole(actor, "admin", "treasurer");
  return all<PaymentRow>(
    `${SELECT} WHERE p.razorpay_payment_id IS NOT NULL
     ORDER BY (p.status <> 'needs_review'), p.paid_at DESC LIMIT 200`,
  ).map(toRecord);
}

/** A reviewer records that the part of a payment that was not owed has been refunded in Razorpay. */
export function resolveOrderPayment(id: string, note: string, actor: SessionUser | null): OrderPaymentRecord {
  const user = requireRole(actor, "admin", "treasurer");
  const ts = nowIso();
  const updated = run(
    `UPDATE order_payments
     SET status = 'refunded', resolved_by = ?, resolved_at = ?, resolution_note = ?, updated_at = ?
     WHERE id = ? AND status = 'needs_review'`,
    user.id,
    ts,
    note,
    ts,
    id,
  );
  if (updated.changes !== 1) {
    load(id);
    throw conflict("not_in_review", "This payment is not waiting for review.");
  }
  return toRecord(load(id));
}
