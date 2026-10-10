import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  SETTINGS,
  type ApplicationMethod,
  type OnlineApplicationAction,
  type OnlineApplicationInput,
  type OnlineApplicationStart,
  type OnlineApplicationState,
  type OnlineApplicationStatus,
  type OnlinePayment,
  type OnlineReconcileAction,
  type OnlineReconcileResult,
  type PaymentMethod,
  type SessionUser,
  type SetupLink,
} from "@/lib/contracts";
import { SETUP_LINK_HOURS, hashToken } from "../auth";
import { all, get, newId, now, nowIso, randomCode, run, tx } from "../db";
import { AppError, conflict, notFound, requireRole } from "../errors";
import {
  checkRazorpayConfig,
  getGateway,
  isValidCheckoutSignature,
  isValidWebhookSignature,
  requireRazorpay,
  toGatewayPayment,
  type GatewayPayment,
} from "../razorpay";
import { admitMember, newSetupLink } from "./members";

/**
 * Paying the membership fee online.
 *
 * 1. The applicant sends their details. The server creates a Razorpay order
 *    for the configured fee and keeps the application in `online_applications`.
 *    Nothing else exists yet: no member, no ledger entry, no sign-in.
 * 2. The browser pays through Razorpay Checkout.
 * 3. A payment counts only when the server has verified it: either the
 *    Checkout signature plus the payment fetched from Razorpay, or a webhook
 *    whose signature is valid, or a lookup of the order at Razorpay. In every
 *    case the order, amount, currency and `captured` status are checked
 *    against what this server stored when it created the order.
 * 4. A verified payment is recorded once (`recordPayment`), then turned into
 *    a member (`tryActivate`). If a member cannot be created, the payment
 *    stays on record as `needs_review` for the treasurer.
 *
 * What the browser says is never proof. A redirect, a payment ID or a
 * "success" callback only makes the server go and check.
 */

type Via = "checkout" | "webhook" | "lookup";

interface OnlineRow {
  id: string;
  code: string;
  name: string;
  email: string;
  student_id: string | null;
  phone: string | null;
  amount_cents: number;
  currency: string;
  access_token_hash: string;
  status: OnlineApplicationStatus;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  payment_method: string | null;
  paid_at: string | null;
  verified_via: Via | null;
  failure_reason: string | null;
  failed_at: string | null;
  review_reason: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  application_id: string | null;
  member_id: string | null;
  setup_link_issued_at: string | null;
  created_at: string;
  updated_at: string;
  member_no: string | null;
  resolved_by_name: string | null;
  has_account: number;
}

const SELECT = `
  SELECT o.*, m.member_no AS member_no, u.name AS resolved_by_name,
    EXISTS (SELECT 1 FROM member_accounts a WHERE a.member_id = o.member_id) AS has_account
  FROM online_applications o
  LEFT JOIN members m ON m.id = o.member_id
  LEFT JOIN users u ON u.id = o.resolved_by`;

const AWAITING_ACTIVATION = "The payment is recorded; creating the member did not finish.";

function load(id: string): OnlineRow {
  const row = get<OnlineRow>(`${SELECT} WHERE o.id = ?`, id);
  if (!row) throw notFound("Application");
  return row;
}

const isOpen = (row: OnlineRow) => row.status === "pending" || row.status === "failed";

// --- availability --------------------------------------------------------------

const currency = () => process.env.NEXT_PUBLIC_CURRENCY ?? "INR";

/** Razorpay's smallest order is 100 paise, and this flow is set up for rupees only. */
const feeIsPayable = () =>
  currency() === "INR" && Number.isInteger(SETTINGS.membershipFeeCents) && SETTINGS.membershipFeeCents >= 100;

export function onlinePaymentAvailable(): boolean {
  return checkRazorpayConfig().ok && feeIsPayable();
}

// --- what the applicant sees -----------------------------------------------------

/** The applicant may collect a link while the account has no password and the payment is recent. */
function linkClaimable(row: OnlineRow): boolean {
  if (row.status !== "activated" || row.has_account === 1 || !row.paid_at) return false;
  return now().getTime() - new Date(row.paid_at).getTime() <= SETUP_LINK_HOURS * 3_600_000;
}

function toState(row: OnlineRow, setup: SetupLink | null, processing = false): OnlineApplicationState {
  const check = checkRazorpayConfig();
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    amountCents: row.amount_cents,
    processing,
    failureReason: row.status === "failed" ? row.failure_reason : null,
    memberNo: row.member_no,
    checkout:
      isOpen(row) && check.ok
        ? {
            keyId: check.config.keyId,
            orderId: row.razorpay_order_id,
            amountCents: row.amount_cents,
            currency: row.currency,
            name: row.name,
            email: row.email,
            phone: row.phone,
          }
        : null,
    setup,
    canRequestLink: linkClaimable(row),
  };
}

/**
 * Hands the password link to the applicant the first time they are seen after
 * activation. Later calls return nothing, so reloading the page cannot cancel
 * a link the person is already using; `new_link` is the explicit way to get another.
 */
function firstLink(id: string): SetupLink | null {
  return tx(() => {
    const row = load(id);
    if (!linkClaimable(row) || row.setup_link_issued_at) return null;
    run("UPDATE online_applications SET setup_link_issued_at = ? WHERE id = ?", nowIso(), id);
    return newSetupLink(row.member_id!, null);
  });
}

/** Finds the application and checks the browser's secret. A wrong secret looks the same as a wrong id. */
function authorise(id: string, token: string): OnlineRow {
  const row = get<OnlineRow>(`${SELECT} WHERE o.id = ?`, id);
  const given = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(row?.access_token_hash ?? hashToken(""), "hex");
  if (!timingSafeEqual(given, stored) || !row) throw notFound("Application");
  return row;
}

// --- recording a verified payment -----------------------------------------------

/** Razorpay's method names, as the ledger's and the application's narrower lists. */
const ledgerMethod = (method: string | null): PaymentMethod =>
  method === "upi" ? "upi" : method === "card" ? "card" : method === "netbanking" ? "bank" : "other";
const applicationMethod = (method: string | null): ApplicationMethod => (method === "upi" ? "upi" : "bank");

/** How a payment differs from the order this server created, or null when it matches. */
function mismatch(row: OnlineRow, payment: GatewayPayment): "order" | "amount" | "currency" | null {
  if (payment.orderId !== row.razorpay_order_id) return "order";
  if (payment.amountCents !== row.amount_cents) return "amount";
  if (payment.currency !== row.currency) return "currency";
  return null;
}

/**
 * Writes a verified, captured payment onto its application, once. The row
 * becomes `needs_review` here and `activated` in `tryActivate`, so the payment
 * is on record even if creating the member fails. Returns false when a
 * payment was already recorded. Callers must have checked `mismatch` first.
 */
function recordPayment(id: string, payment: GatewayPayment, via: Via): boolean {
  return tx(() => {
    const row = load(id);
    if (row.razorpay_payment_id) {
      if (row.razorpay_payment_id !== payment.id) {
        // Razorpay allows one captured payment per order. If a second ever arrives, keep the evidence.
        run(
          "UPDATE online_applications SET review_reason = ?, updated_at = ? WHERE id = ?",
          `A second payment (${payment.id}) was captured for this order. Refund it in Razorpay.`,
          nowIso(),
          id,
        );
      }
      return false;
    }
    const ts = nowIso();
    const updated = run(
      `UPDATE online_applications
       SET status = 'needs_review', razorpay_payment_id = ?, payment_method = ?, paid_at = ?, verified_via = ?,
           review_reason = ?, updated_at = ?
       WHERE id = ? AND razorpay_payment_id IS NULL`,
      payment.id,
      payment.method,
      ts,
      via,
      AWAITING_ACTIVATION,
      ts,
      id,
    );
    return updated.changes === 1;
  });
}

/** Why a paid application cannot become a member right now, or null. */
function blocker(row: OnlineRow): string | null {
  if (get("SELECT 1 FROM members WHERE email = ?", row.email)) {
    return "This email already belongs to a member, so no second member was created.";
  }
  if (
    get(
      "SELECT 1 FROM membership_applications WHERE payment_reference = ? AND status <> 'rejected'",
      row.razorpay_payment_id,
    )
  ) {
    return "This payment reference is already on another application.";
  }
  return null;
}

/**
 * Creates the member for a paid application: the member, their paid term, the
 * dues entry in the ledger and an approved application row, in one
 * transaction. Does nothing unless the row is `needs_review`, so calling it
 * again, or from two places at once, cannot create a second member.
 */
function tryActivate(id: string, resolvedBy: string | null = null): void {
  try {
    tx(() => {
      const row = load(id);
      if (row.status !== "needs_review" || !row.razorpay_payment_id) return;
      const ts = nowIso();
      const reason = blocker(row);
      if (reason) {
        run("UPDATE online_applications SET review_reason = ?, updated_at = ? WHERE id = ?", reason, ts, id);
        return;
      }

      const member = admitMember(
        { name: row.name, email: row.email, studentId: row.student_id, phone: row.phone },
        {
          method: ledgerMethod(row.payment_method),
          reference: row.razorpay_payment_id,
          createdBy: resolvedBy,
          amountCents: row.amount_cents,
          note: `Razorpay ${row.razorpay_payment_id}`,
        },
      );

      let code = row.code;
      while (get("SELECT 1 FROM membership_applications WHERE code = ?", code)) code = newCode();
      const applicationId = newId("app");
      run(
        `INSERT INTO membership_applications
           (id, code, name, email, student_id, phone, amount_cents, payment_method, payment_reference,
            evidence_file_id, status, review_note, reviewed_by, reviewed_at, member_id, created_at, channel)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'approved', ?, ?, ?, ?, ?, 'razorpay')`,
        applicationId,
        code,
        row.name,
        row.email,
        row.student_id,
        row.phone,
        row.amount_cents,
        applicationMethod(row.payment_method),
        row.razorpay_payment_id,
        "Paid online; verified with Razorpay.",
        resolvedBy,
        ts,
        member.id,
        row.created_at,
      );
      const updated = run(
        `UPDATE online_applications
         SET status = 'activated', member_id = ?, application_id = ?, code = ?, review_reason = NULL,
             resolved_by = ?, resolved_at = ?, updated_at = ?
         WHERE id = ? AND status = 'needs_review'`,
        member.id,
        applicationId,
        code,
        resolvedBy,
        resolvedBy ? ts : null,
        ts,
        id,
      );
      if (updated.changes !== 1) throw conflict("already_activated", "This application was already completed.");
    });
  } catch (error) {
    // The transaction rolled back; the recorded payment is untouched. Leave a reason for the reviewer.
    if (!(error instanceof AppError)) console.error(`[online-applications] activation of ${id} failed`, error);
    const reason = error instanceof AppError ? error.message : "Creating the member failed unexpectedly. Try again.";
    run(
      "UPDATE online_applications SET review_reason = ?, updated_at = ? WHERE id = ? AND status = 'needs_review'",
      reason,
      nowIso(),
      id,
    );
  }
}

function markFailed(id: string, reason: string | null): boolean {
  const ts = nowIso();
  return (
    run(
      `UPDATE online_applications SET status = 'failed', failure_reason = ?, failed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending','failed')`,
      (reason ?? "The payment did not go through.").slice(0, 200),
      ts,
      ts,
      id,
    ).changes === 1
  );
}

type Resolution = "settled" | "processing" | "failed" | "none";

/**
 * Acts on a payment that came from Razorpay's API. Only a captured payment
 * that matches the stored order is recorded. An authorised one is captured
 * for the exact amount first; anything else leaves the application unpaid.
 */
async function resolvePayment(row: OnlineRow, fetched: GatewayPayment, via: Via): Promise<Resolution> {
  let payment = fetched;
  const reject = (what: string) => {
    console.error(`[online-applications] payment ${payment.id} does not match ${row.code}: ${what}`);
    return new AppError("payment_mismatch", "That payment does not match this application.", 409);
  };
  let bad = mismatch(row, payment);
  if (bad) throw reject(bad);

  if (payment.status === "authorized") {
    try {
      payment = await getGateway().capturePayment(payment.id, row.amount_cents, row.currency);
    } catch {
      return "processing";
    }
    bad = mismatch(row, payment);
    if (bad) throw reject(bad);
  }
  if (payment.status === "captured") {
    recordPayment(row.id, payment, via);
    tryActivate(row.id);
    return "settled";
  }
  if (payment.status === "failed" || payment.status === "refunded") {
    markFailed(row.id, payment.status === "refunded" ? "The payment was refunded." : payment.errorDescription);
    return "failed";
  }
  return "processing";
}

/** Asks Razorpay whether the order was paid, for when neither the browser nor a webhook told us. */
async function syncWithProvider(row: OnlineRow): Promise<Resolution> {
  if (row.razorpay_payment_id) return "settled";
  const payments = await getGateway().listOrderPayments(row.razorpay_order_id);
  const paid = payments.find((p) => p.status === "captured") ?? payments.find((p) => p.status === "authorized");
  return paid ? resolvePayment(row, paid, "lookup") : "none";
}

// --- the applicant's actions -----------------------------------------------------

const newCode = () => {
  let code = `APP-${randomCode(6)}`;
  while (
    get("SELECT 1 FROM membership_applications WHERE code = ?", code) ||
    get("SELECT 1 FROM online_applications WHERE code = ?", code)
  ) {
    code = `APP-${randomCode(6)}`;
  }
  return code;
};

function assertCanApply(email: string): void {
  if (get("SELECT 1 FROM members WHERE email = ?", email)) {
    throw conflict(
      "already_member",
      "This email already belongs to a member. Sign in, or ask the committee for a password link.",
    );
  }
  if (get("SELECT 1 FROM membership_applications WHERE email = ? AND status = 'pending'", email)) {
    throw conflict("application_pending", "An application for this email is already waiting for review.");
  }
  if (get("SELECT 1 FROM online_applications WHERE email = ? AND status = 'needs_review'", email)) {
    throw conflict(
      "already_paid",
      "A payment for this email has already been received and is with the committee. You do not need to pay again.",
    );
  }
}

/** Step 1: store the application and create its Razorpay order. Creates no member and no ledger entry. */
export async function startOnlineApplication(input: OnlineApplicationInput): Promise<OnlineApplicationStart> {
  requireRazorpay();
  if (!feeIsPayable()) throw new AppError("payments_not_configured", "Online payment is not set up yet.", 503);
  assertCanApply(input.email);

  // An earlier attempt may have been paid without this server hearing of it
  // (browser closed, no webhook). Check before taking a second payment.
  const earlier = get<OnlineRow>(`${SELECT} WHERE o.email = ? AND o.status IN ('pending','failed')`, input.email);
  if (earlier && (await syncWithProvider(earlier)) === "settled") {
    throw conflict(
      "already_paid",
      "A payment for this email has already been received. Ask the committee for your password link.",
    );
  }

  const amountCents = SETTINGS.membershipFeeCents;
  const code = newCode();
  const order = await getGateway().createOrder({
    amountCents,
    currency: currency(),
    receipt: code,
    notes: { purpose: "membership", application: code },
  });
  if (order.amountCents !== amountCents || order.currency !== currency()) {
    console.error(`[online-applications] order for ${code} came back with a different amount or currency`);
    throw new AppError("payment_provider_unavailable", "The payment could not be started. Try again.", 502);
  }

  const id = newId("oap");
  const accessToken = randomBytes(32).toString("base64url");
  tx(() => {
    assertCanApply(input.email);
    const ts = nowIso();
    // The person started again: close the earlier attempt. A late payment on it is still honoured.
    run(
      `UPDATE online_applications SET status = 'superseded', updated_at = ?
       WHERE email = ? AND status IN ('pending','failed')`,
      ts,
      input.email,
    );
    run(
      `INSERT INTO online_applications
         (id, code, name, email, student_id, phone, amount_cents, currency, access_token_hash, status,
          razorpay_order_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      id,
      code,
      input.name,
      input.email,
      input.studentId,
      input.phone,
      amountCents,
      currency(),
      hashToken(accessToken),
      order.id,
      ts,
      ts,
    );
  });
  return { ...toState(load(id), null), accessToken };
}

/**
 * Everything the applicant's browser may do with its application. Each action
 * needs the access token issued when the application was started.
 */
export async function onlineApplicationAction(
  id: string,
  action: OnlineApplicationAction,
): Promise<OnlineApplicationState> {
  const row = authorise(id, action.token);
  let processing = false;

  switch (action.action) {
    case "confirm": {
      // The webhook may have got here first; then there is nothing left to verify.
      if (row.razorpay_payment_id) break;
      const config = requireRazorpay();
      // Signed over the order id this server stored, not the one in the request.
      if (
        action.razorpayOrderId !== row.razorpay_order_id ||
        !isValidCheckoutSignature(config, row.razorpay_order_id, action.razorpayPaymentId, action.razorpaySignature)
      ) {
        throw new AppError("payment_unverified", "That payment could not be verified. You have not been charged twice; try again.", 400);
      }
      const payment = await getGateway().fetchPayment(action.razorpayPaymentId);
      processing = (await resolvePayment(row, payment, "checkout")) === "processing";
      break;
    }
    case "resume": {
      // Coming back after closing the browser: the order may have been paid meanwhile.
      if (!row.razorpay_payment_id && row.status !== "refunded" && checkRazorpayConfig().ok) {
        try {
          processing = (await syncWithProvider(row)) === "processing";
        } catch (error) {
          // Razorpay being unreachable must not hide what is already known.
          if (!(error instanceof AppError) || error.code === "payment_mismatch") throw error;
        }
      }
      break;
    }
    case "failed": {
      // Only a note for the applicant's own screen. A failure reported by the browser decides nothing.
      if (isOpen(row)) markFailed(row.id, action.reason);
      break;
    }
    case "new_link": {
      const link = tx(() => {
        const current = load(id);
        if (!linkClaimable(current)) {
          throw conflict("link_unavailable", "Ask the committee for a new password link.");
        }
        run("UPDATE online_applications SET setup_link_issued_at = ? WHERE id = ?", nowIso(), id);
        return newSetupLink(current.member_id!, null);
      });
      return toState(load(id), link);
    }
  }

  // A recorded payment whose member was not created yet gets another try.
  if (load(id).status === "needs_review") tryActivate(id);
  return toState(load(id), firstLink(id), processing);
}

// --- webhooks ------------------------------------------------------------------

const PAID_EVENTS = new Set(["payment.captured", "order.paid"]);

/**
 * Handles one Razorpay webhook. The signature is checked over the exact bytes
 * received before anything is parsed. Each event id is processed once: the
 * event row and its effect are written in the same transaction, so a repeat
 * delivery finds the row and does nothing, and a crash leaves neither.
 * Events may arrive late or out of order; a `payment.failed` that turns up
 * after the payment was captured changes nothing.
 */
export function handleRazorpayWebhook(
  rawBody: Buffer,
  signature: string | null,
  eventIdHeader: string | null,
): { outcome: string } {
  const { webhookSecret } = requireRazorpay();
  if (!webhookSecret) {
    throw new AppError("payments_not_configured", "Webhooks are not set up.", 503);
  }
  if (!signature || !isValidWebhookSignature(webhookSecret, rawBody, signature)) {
    throw new AppError("bad_signature", "The webhook signature is not valid.", 401);
  }

  let event: { event?: unknown; payload?: { payment?: { entity?: unknown } } };
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new AppError("invalid_json", "The webhook body is not valid JSON.", 400);
  }
  const type = typeof event?.event === "string" ? event.event.slice(0, 60) : "unknown";
  const eventId =
    eventIdHeader && /^[A-Za-z0-9_.:-]{1,100}$/.test(eventIdHeader)
      ? eventIdHeader
      : `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
  const payment = toGatewayPayment(event?.payload?.payment?.entity);

  let activate: string | null = null;
  const outcome = tx(() => {
    if (get("SELECT 1 FROM razorpay_webhook_events WHERE event_id = ?", eventId)) return "duplicate";

    let result = "ignored";
    const row = payment?.orderId
      ? get<OnlineRow>(`${SELECT} WHERE o.razorpay_order_id = ?`, payment.orderId)
      : undefined;
    if (payment && row && PAID_EVENTS.has(type)) {
      const bad = mismatch(row, payment);
      if (bad) {
        console.error(`[online-applications] webhook payment ${payment.id} does not match ${row.code}: ${bad}`);
        result = `rejected_${bad}_mismatch`;
      } else if (payment.status !== "captured") {
        result = "ignored_not_captured";
      } else {
        result = recordPayment(row.id, payment, "webhook") ? "recorded" : "already_recorded";
        activate = row.id;
      }
    } else if (payment && row && type === "payment.failed") {
      result = markFailed(row.id, payment.errorDescription) ? "marked_failed" : "ignored_already_paid";
    } else if (payment && !row) {
      result = "ignored_unknown_order";
    }

    run(
      `INSERT INTO razorpay_webhook_events (event_id, event_type, order_id, payment_id, outcome, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      eventId,
      type,
      payment?.orderId ?? null,
      payment?.id ?? null,
      result,
      nowIso(),
    );
    return result;
  });

  if (activate) tryActivate(activate);
  return { outcome };
}

// --- the committee's side ------------------------------------------------------

const toPayment = (r: OnlineRow): OnlinePayment => ({
  id: r.id,
  code: r.code,
  name: r.name,
  email: r.email,
  studentId: r.student_id,
  phone: r.phone,
  amountCents: r.amount_cents,
  currency: r.currency,
  status: r.status,
  razorpayOrderId: r.razorpay_order_id,
  razorpayPaymentId: r.razorpay_payment_id,
  paymentMethod: r.payment_method,
  paidAt: r.paid_at,
  verifiedVia: r.verified_via,
  failureReason: r.failure_reason,
  reviewReason: r.review_reason,
  resolvedByName: r.resolved_by_name,
  resolvedAt: r.resolved_at,
  resolutionNote: r.resolution_note,
  memberId: r.member_id,
  memberNo: r.member_no,
  hasAccount: r.has_account === 1,
  createdAt: r.created_at,
});

/** Online applications, those needing a reviewer first. Replaced attempts that were never paid are left out. */
export function listOnlinePayments(actor: SessionUser | null): OnlinePayment[] {
  requireRole(actor, "admin", "treasurer");
  return all<OnlineRow>(
    `${SELECT} WHERE o.status <> 'superseded'
     ORDER BY (o.status <> 'needs_review'), o.created_at DESC LIMIT 200`,
  ).map(toPayment);
}

/**
 * A reviewer sorts out an online application. None of these can create a
 * member without a payment that Razorpay has confirmed: `check` asks Razorpay,
 * and `activate` only acts on a payment already recorded.
 */
export async function reconcileOnlinePayment(
  id: string,
  action: OnlineReconcileAction,
  actor: SessionUser | null,
): Promise<OnlineReconcileResult> {
  const user = requireRole(actor, "admin", "treasurer");
  const row = load(id);

  if (action.action === "check") {
    if (row.razorpay_payment_id) throw conflict("already_paid", "This payment is already recorded.");
    const result = await syncWithProvider(row);
    if (result === "processing") {
      throw conflict("payment_processing", "Razorpay is still processing a payment for this order. Check again shortly.");
    }
    if (result !== "settled") throw conflict("not_paid", "Razorpay has no completed payment for this order.");
  } else if (action.action === "activate") {
    if (row.status !== "needs_review") throw conflict("not_in_review", "This application is not waiting for review.");
    tryActivate(id, user.id);
    const after = load(id);
    if (after.status !== "activated") {
      throw conflict("cannot_activate", after.review_reason ?? "The member could not be created.");
    }
  } else {
    const ts = nowIso();
    const updated = run(
      `UPDATE online_applications
       SET status = 'refunded', resolved_by = ?, resolved_at = ?, resolution_note = ?, updated_at = ?
       WHERE id = ? AND status = 'needs_review'`,
      user.id,
      ts,
      action.note,
      ts,
      id,
    );
    if (updated.changes !== 1) throw conflict("not_in_review", "This application is not waiting for review.");
  }

  // When this action created the member, the reviewer gets the link to pass on,
  // as they do when approving a manual application.
  const after = load(id);
  let setup: SetupLink | null = null;
  if (!row.member_id && after.member_id) {
    run("UPDATE online_applications SET setup_link_issued_at = ? WHERE id = ?", nowIso(), id);
    setup = newSetupLink(after.member_id, user.id);
  }
  return { payment: toPayment(load(id)), setup };
}
