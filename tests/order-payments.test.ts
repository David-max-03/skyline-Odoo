import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkoutInputSchema,
  memberInputSchema,
  orderPaymentActionSchema,
  productInputSchema,
  type Member,
  type OrderPaymentState,
  type Product,
  type ShopOrder,
} from "@/lib/contracts";
import { all, get } from "@/server/db";
import { AppError } from "@/server/errors";
import { signCheckout, signWebhook, type GatewayPayment } from "@/server/razorpay";
import { listTransactions } from "@/server/services/finance";
import { createMember, getMember, listMembers } from "@/server/services/members";
import { actOnOrder, checkout, checkoutAsMember, createProduct, getProduct, listMemberOrders } from "@/server/services/merch";
import { handleRazorpayWebhook } from "@/server/services/online-applications";
import { listOrderPayments, orderPaymentAction, resolveOrderPayment } from "@/server/services/order-payments";
import { FakeRazorpay, KEY_ID, KEY_SECRET, WEBHOOK_SECRET, clearFakeRazorpay, useFakeRazorpay } from "./fake-razorpay";
import { freshDb, type Staff } from "./helpers";

/** Every Razorpay reply here comes from `FakeRazorpay`. No test makes a network request. */

let staff: Staff;
let razorpay: FakeRazorpay;
let hoodie: Product;
let buyer: Member;
let other: Member;

const member = (n: number) =>
  createMember(memberInputSchema.parse({ name: `Member ${n}`, email: `member${n}@campus.example`, duesPaid: true }), staff.treasurer);
const size = (p: Product, s: string) => p.variants.find((v) => v.size === s)!.id;

beforeEach(() => {
  staff = freshDb();
  razorpay = useFakeRazorpay();
  hoodie = createProduct(
    productInputSchema.parse({
      name: "Hoodie",
      priceCents: 120000,
      memberPriceCents: 100000,
      variants: [{ size: "M", stock: 10 }, { size: "L", stock: 10 }],
    }),
    staff.treasurer,
  );
  buyer = member(1);
  other = member(2);
});

afterEach(clearFakeRazorpay);

/** A two-line order: one M (₹1,000) and two L (₹2,000) at the member price. */
const twoLineOrder = (who: Member = buyer) =>
  checkoutAsMember([{ variantId: size(hoodie, "M"), quantity: 1 }, { variantId: size(hoodie, "L"), quantity: 2 }], who.id);

const start = (order: ShopOrder, who: Member = buyer) => orderPaymentAction(who.id, order.code, { action: "start" });

const confirm = (order: ShopOrder, state: OrderPaymentState, payment: GatewayPayment, who: Member = buyer, signature?: string) =>
  orderPaymentAction(who.id, order.code, {
    action: "confirm",
    razorpayOrderId: state.checkout!.orderId,
    razorpayPaymentId: payment.id,
    razorpaySignature: signature ?? signCheckout(KEY_SECRET, state.checkout!.orderId, payment.id),
  });

let eventCounter = 0;
function webhook(type: string, payment: GatewayPayment, eventId = `evt_order_${++eventCounter}`) {
  const body = Buffer.from(
    JSON.stringify({
      event: type,
      payload: {
        payment: {
          entity: {
            id: payment.id,
            order_id: payment.orderId,
            amount: payment.amountCents,
            currency: payment.currency,
            status: payment.status,
            method: payment.method,
            error_description: payment.errorDescription,
          },
        },
      },
    }),
  );
  return handleRazorpayWebhook(body, signWebhook(WEBHOOK_SECRET, body), eventId);
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("Expected an AppError, but nothing was thrown");
}

function thrown(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("Expected an AppError, but nothing was thrown");
}

const mine = (who: Member = buyer) => listMemberOrders(who.id)[0];
const merchLedger = () => listTransactions().filter((t) => t.category === "merchandise");
const settledMerch = () => merchLedger().filter((t) => t.status === "settled");
const attempts = () => all<{ status: string; razorpay_payment_id: string | null; amount_cents: number }>("SELECT status, razorpay_payment_id, amount_cents FROM order_payments ORDER BY created_at, rowid");
const nothingPaid = () => {
  expect(mine().lines.every((l) => l.paymentStatus === "pending")).toBe(true);
  expect(settledMerch()).toHaveLength(0);
  expect(attempts().every((a) => a.razorpay_payment_id === null)).toBe(true);
};

describe("starting a payment", () => {
  it("creates a Razorpay order for what the member's order owes, in rupees", async () => {
    const order = twoLineOrder();
    expect(order).toMatchObject({ totalCents: 300000, unpaidCents: 300000, payOnline: true });

    const state = await start(order);
    expect(razorpay.orders).toEqual([{ id: state.checkout!.orderId, amountCents: 300000, currency: "INR", receipt: order.code }]);
    expect(state.checkout).toMatchObject({ keyId: KEY_ID, amountCents: 300000, currency: "INR", email: buyer.email });
    expect(JSON.stringify(state)).not.toContain(KEY_SECRET);
    expect(state.order.unpaidCents).toBe(300000);
    nothingPaid();
  });

  it("takes the amount from the order, whatever the request says", async () => {
    const order = twoLineOrder();
    // Extra fields a browser might add are dropped before the service ever sees them.
    const tampered = orderPaymentActionSchema.parse({ action: "start", amount: 100, amountCents: 100, totalCents: 1, memberId: other.id, paid: true });
    expect(tampered).toEqual({ action: "start" });
    const state = await orderPaymentAction(buyer.id, order.code, tampered);
    expect(state.checkout!.amountCents).toBe(300000);
    expect(razorpay.orders[0].amountCents).toBe(300000);
  });

  it("charges only the lines still owed", async () => {
    const order = twoLineOrder();
    actOnOrder(order.lines[0].orderId, "pay", "cash", staff.treasurer); // ₹1,000 paid in cash
    const state = await start(order);
    expect(state.checkout!.amountCents).toBe(200000);
  });

  it("refuses someone else's order and an order that does not exist, identically", async () => {
    const order = twoLineOrder();
    const theirs = await rejection(start(order, other));
    const missing = await rejection(orderPaymentAction(buyer.id, "CHK-NOSUCH", { action: "start" }));
    expect(theirs).toMatchObject({ code: "not_found", status: 404 });
    expect(missing).toMatchObject({ code: "not_found", status: 404 });
    expect(theirs.message).toBe(missing.message);
    expect(razorpay.orders).toHaveLength(0);
  });

  it("refuses an order that is already paid", async () => {
    const order = twoLineOrder();
    for (const line of order.lines) actOnOrder(line.orderId, "pay", "cash", staff.treasurer);
    expect(mine().payOnline).toBe(false);
    expect(await rejection(start(order))).toMatchObject({ code: "nothing_to_pay", status: 409 });
    expect(razorpay.orders).toHaveLength(0);
  });

  it("returns a safe error when Razorpay is not configured, and leaves the shop working", async () => {
    delete process.env.SKYLINE_RAZORPAY_MODE;
    const order = twoLineOrder();
    expect(order.payOnline).toBe(false);
    const error = await rejection(start(order));
    expect(error).toMatchObject({ code: "payments_not_configured", status: 503 });
    expect(error.message).not.toContain(KEY_SECRET);
    expect(mine()).toMatchObject({ unpaidCents: 300000, payOnline: false });
    actOnOrder(order.lines[0].orderId, "pay", "cash", staff.treasurer);
    expect(mine().unpaidCents).toBe(200000);
  });

  it("does not offer online payment to a visitor's order", () => {
    const guestOrder = checkout(
      checkoutInputSchema.parse({ items: [{ variantId: size(hoodie, "M"), quantity: 1 }], name: "Visitor", email: "visitor@campus.example" }),
    );
    expect(guestOrder.payOnline).toBe(false);
  });

  it("reuses the same Razorpay order for repeated and simultaneous clicks", async () => {
    const order = twoLineOrder();
    const [a, b, c] = await Promise.all([start(order), start(order), start(order)]);
    const again = await start(order);
    const ids = new Set([a, b, c, again].map((s) => s.checkout!.orderId));
    expect(ids.size).toBe(1);
    expect(attempts().filter((x) => x.status === "pending")).toHaveLength(1);
  });

  it("starts a fresh payment when the amount owed has changed", async () => {
    const order = twoLineOrder();
    const first = await start(order);
    actOnOrder(order.lines[0].orderId, "pay", "cash", staff.treasurer);
    const second = await start(order);
    expect(second.checkout!.orderId).not.toBe(first.checkout!.orderId);
    expect(second.checkout!.amountCents).toBe(200000);
    expect(attempts().map((a) => a.status)).toEqual(["superseded", "pending"]);
  });
});

describe("verifying a payment", () => {
  it("marks the order paid, settles each line once in the ledger, and leaves hand-over alone", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    const payment = razorpay.pay(state.checkout!.orderId);
    const done = await confirm(order, state, payment);

    expect(done).toMatchObject({ checkout: null, processing: false, failureReason: null });
    expect(done.order).toMatchObject({ unpaidCents: 0, totalCents: 300000, payOnline: false });
    expect(done.order.lines.map((l) => [l.paymentStatus, l.status])).toEqual([["paid", "placed"], ["paid", "placed"]]);

    const ledger = merchLedger();
    expect(ledger).toHaveLength(2);
    expect(ledger.every((t) => t.status === "settled" && t.method === "upi" && t.description.includes(payment.id))).toBe(true);
    expect(ledger.reduce((sum, t) => sum + t.amountCents, 0)).toBe(300000);
    expect(attempts()).toEqual([{ status: "paid", razorpay_payment_id: payment.id, amount_cents: 300000 }]);

    // Hand-over is still the committee's separate step.
    actOnOrder(order.lines[0].orderId, "fulfil", "cash", staff.treasurer);
    expect(mine().lines.map((l) => l.status)).toEqual(["fulfilled", "placed"]);
  });

  it("rejects an invalid signature", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    const payment = razorpay.pay(state.checkout!.orderId);
    for (const signature of [signCheckout("another-secret", state.checkout!.orderId, payment.id), "0".repeat(64)]) {
      expect(await rejection(confirm(order, state, payment, buyer, signature))).toMatchObject({ code: "payment_unverified", status: 400 });
    }
    nothingPaid();
  });

  it("rejects a payment that belongs to a different Razorpay order", async () => {
    const mineOrder = twoLineOrder();
    const theirOrder = twoLineOrder(other);
    const mineState = await start(mineOrder);
    const theirState = await start(theirOrder, other);
    const theirPayment = razorpay.pay(theirState.checkout!.orderId);

    // Correctly signed for my Razorpay order, but the payment is for theirs.
    expect(await rejection(confirm(mineOrder, mineState, theirPayment))).toMatchObject({ code: "payment_mismatch", status: 409 });
    // Their Razorpay order id presented against my order: there is no such attempt on my order.
    const crossed = orderPaymentAction(buyer.id, mineOrder.code, {
      action: "confirm",
      razorpayOrderId: theirState.checkout!.orderId,
      razorpayPaymentId: theirPayment.id,
      razorpaySignature: signCheckout(KEY_SECRET, theirState.checkout!.orderId, theirPayment.id),
    });
    expect(await rejection(crossed)).toMatchObject({ code: "payment_unverified" });
    nothingPaid();
    expect(mine(other).unpaidCents).toBe(300000);
  });

  it("rejects the wrong amount and the wrong currency", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    const short = razorpay.pay(state.checkout!.orderId, { amountCents: 100 });
    expect(await rejection(confirm(order, state, short))).toMatchObject({ code: "payment_mismatch" });
    const dollars = razorpay.pay(state.checkout!.orderId, { currency: "USD" });
    expect(await rejection(confirm(order, state, dollars))).toMatchObject({ code: "payment_mismatch" });
    nothingPaid();
  });

  it("leaves the order unpaid after a failed payment, and lets the same order be paid again", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    const failed = razorpay.pay(state.checkout!.orderId, { status: "failed", errorDescription: "Declined by the bank" });
    const after = await confirm(order, state, failed);
    expect(after).toMatchObject({ failureReason: "Declined by the bank" });
    expect(after.checkout!.orderId).toBe(state.checkout!.orderId);
    nothingPaid();

    const retry = await start(order);
    expect(retry.checkout!.orderId).toBe(state.checkout!.orderId);
    expect(razorpay.orders).toHaveLength(1);
    expect((await confirm(order, retry, razorpay.pay(retry.checkout!.orderId))).order.unpaidCents).toBe(0);
  });

  it("treats a closed Checkout window as a note only", async () => {
    const order = twoLineOrder();
    await start(order);
    const state = await orderPaymentAction(buyer.id, order.code, { action: "failed", reason: "Payment window closed" });
    expect(state).toMatchObject({ failureReason: "Payment window closed" });
    expect(state.checkout).not.toBeNull();
    nothingPaid();
  });

  it("does not mark an order paid for a payment that is not captured", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    // Still being processed at Razorpay.
    const created = razorpay.pay(state.checkout!.orderId, { status: "created" });
    expect(await confirm(order, state, created)).toMatchObject({ processing: true });
    nothingPaid();
    // Authorised, and the capture does not go through.
    razorpay.captureFails = true;
    const authorised = razorpay.pay(state.checkout!.orderId, { status: "authorized", method: "card" });
    expect(await confirm(order, state, authorised)).toMatchObject({ processing: true });
    nothingPaid();
  });

  it("captures an authorised payment for the exact amount before marking the order paid", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    const authorised = razorpay.pay(state.checkout!.orderId, { status: "authorized", method: "card" });
    const done = await confirm(order, state, authorised);
    expect(razorpay.captures).toBe(1);
    expect(done.order.unpaidCents).toBe(0);
    expect(settledMerch().every((t) => t.method === "card")).toBe(true);
  });

  it("is safe to verify repeatedly and at the same time", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    const payment = razorpay.pay(state.checkout!.orderId);
    const results = await Promise.all([confirm(order, state, payment), confirm(order, state, payment), confirm(order, state, payment)]);
    const again = await confirm(order, state, payment);

    for (const result of [...results, again]) expect(result.order.unpaidCents).toBe(0);
    expect(merchLedger()).toHaveLength(2);
    expect(settledMerch()).toHaveLength(2);
    expect(settledMerch().reduce((sum, t) => sum + t.amountCents, 0)).toBe(300000);
    expect(attempts()).toEqual([{ status: "paid", razorpay_payment_id: payment.id, amount_cents: 300000 }]);
    expect(await rejection(start(order))).toMatchObject({ code: "nothing_to_pay" });
    expect(razorpay.orders).toHaveLength(1);
  });

  it("checks ownership on confirm, check and failed as well as start", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    const payment = razorpay.pay(state.checkout!.orderId);
    expect(await rejection(confirm(order, state, payment, other))).toMatchObject({ code: "not_found" });
    expect(await rejection(orderPaymentAction(other.id, order.code, { action: "check" }))).toMatchObject({ code: "not_found" });
    expect(await rejection(orderPaymentAction(other.id, order.code, { action: "failed", reason: null }))).toMatchObject({ code: "not_found" });
    nothingPaid();
  });

  it("finds a payment at Razorpay when the browser closed before confirming", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    razorpay.pay(state.checkout!.orderId);
    nothingPaid();
    const checked = await orderPaymentAction(buyer.id, order.code, { action: "check" });
    expect(checked.order.unpaidCents).toBe(0);
    expect(settledMerch()).toHaveLength(2);
  });

  it("does not take a second payment when the first was never reported back", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    razorpay.pay(state.checkout!.orderId);
    // Clicking Pay online again first asks Razorpay about the open attempt.
    const second = await start(order);
    expect(second).toMatchObject({ checkout: null });
    expect(second.order.unpaidCents).toBe(0);
    expect(razorpay.orders).toHaveLength(1);
  });
});

describe("webhooks for merchandise", () => {
  it("marks the order paid from a signed webhook, once", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    const payment = razorpay.pay(state.checkout!.orderId);

    expect(webhook("payment.captured", payment, "evt_m_1").outcome).toBe("order_paid");
    expect(webhook("payment.captured", payment, "evt_m_1").outcome).toBe("duplicate");
    expect(webhook("order.paid", payment, "evt_m_2").outcome).toBe("already_recorded");
    expect(mine().unpaidCents).toBe(0);
    expect(settledMerch()).toHaveLength(2);

    // The browser returning afterwards finds it done and adds nothing.
    expect((await confirm(order, state, payment)).order.unpaidCents).toBe(0);
    expect(settledMerch()).toHaveLength(2);
  });

  it("rejects an unsigned or wrongly signed webhook", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    const payment = razorpay.pay(state.checkout!.orderId);
    const body = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: payment.id, order_id: payment.orderId, amount: payment.amountCents, currency: "INR", status: "captured" } } } }));
    expect(thrown(() => handleRazorpayWebhook(body, null, "evt_x")).code).toBe("bad_signature");
    expect(thrown(() => handleRazorpayWebhook(body, signWebhook("wrong-secret", body), "evt_y")).code).toBe("bad_signature");
    nothingPaid();
  });

  it("ignores a wrong amount, an uncaptured payment, and a late failure", async () => {
    const order = twoLineOrder();
    const state = await start(order);
    expect(webhook("payment.captured", razorpay.pay(state.checkout!.orderId, { amountCents: 1 })).outcome).toBe("rejected_amount_mismatch");
    expect(webhook("payment.captured", razorpay.pay(state.checkout!.orderId, { status: "authorized" })).outcome).toBe("ignored_not_captured");
    nothingPaid();

    const payment = razorpay.pay(state.checkout!.orderId);
    webhook("payment.captured", payment);
    expect(webhook("payment.failed", { ...payment, id: "pay_Test0000000999", status: "failed" }).outcome).toBe("ignored_already_paid");
    expect(mine().unpaidCents).toBe(0);
  });

  it("never touches memberships", async () => {
    const before = JSON.stringify([listMembers(), getMember(buyer.id).periods]);
    const order = twoLineOrder();
    const state = await start(order);
    webhook("payment.captured", razorpay.pay(state.checkout!.orderId));
    expect(JSON.stringify([listMembers(), getMember(buyer.id).periods])).toBe(before);
    expect(get("SELECT 1 FROM online_applications")).toBeUndefined();
    expect(get("SELECT 1 FROM membership_applications")).toBeUndefined();
  });
});

describe("manual and online payment together", () => {
  it("keeps the committee's manual payment and hand-over working", async () => {
    const order = twoLineOrder();
    actOnOrder(order.lines[0].orderId, "pay", "cash", staff.treasurer);
    actOnOrder(order.lines[0].orderId, "fulfil", "cash", staff.treasurer);
    expect(mine().lines.map((l) => [l.paymentStatus, l.status])).toEqual([["paid", "fulfilled"], ["pending", "placed"]]);
    expect(thrown(() => actOnOrder(order.lines[1].orderId, "fulfil", "cash", staff.treasurer)).code).toBe("payment_required");

    // The rest is paid online; the cash line is not charged again.
    const state = await start(order);
    await confirm(order, state, razorpay.pay(state.checkout!.orderId));
    expect(mine().unpaidCents).toBe(0);
    expect(settledMerch().map((t) => t.method).sort()).toEqual(["cash", "upi"]);
    expect(thrown(() => actOnOrder(order.lines[1].orderId, "pay", "cash", staff.treasurer)).code).toBe("not_pending");
  });

  it("does not pay a line twice when cash is taken while the member is paying online", async () => {
    const order = twoLineOrder();
    const state = await start(order); // ₹3,000 for both lines
    actOnOrder(order.lines[0].orderId, "pay", "cash", staff.treasurer); // ₹1,000 in cash meanwhile
    const payment = razorpay.pay(state.checkout!.orderId);
    webhook("payment.captured", payment);

    expect(mine().unpaidCents).toBe(0);
    const settled = settledMerch();
    expect(settled).toHaveLength(2);
    expect(settled.reduce((sum, t) => sum + t.amountCents, 0)).toBe(300000); // not 4,000

    // The ₹1,000 that was not owed is on record for a refund, and cannot be paid for again meanwhile.
    const [review] = listOrderPayments(staff.treasurer);
    expect(review).toMatchObject({ status: "needs_review", amountCents: 300000, appliedCents: 200000, razorpayPaymentId: payment.id });
    const resolved = resolveOrderPayment(review.id, "Refunded ₹1,000 in the dashboard", staff.treasurer);
    expect(resolved).toMatchObject({ status: "refunded", resolvedByName: "Treasurer" });
    expect(thrown(() => resolveOrderPayment(review.id, "again", staff.treasurer)).code).toBe("not_in_review");
  });

  it("keeps the payment records to the treasurer and president", () => {
    expect(thrown(() => listOrderPayments(staff.organizer)).code).toBe("forbidden");
    expect(thrown(() => listOrderPayments(null)).code).toBe("unauthorized");
    expect(thrown(() => resolveOrderPayment("opy_x", "note", staff.organizer)).code).toBe("forbidden");
    expect(listOrderPayments(staff.admin)).toEqual([]);
  });

  it("leaves stock and other members' orders alone", async () => {
    const order = twoLineOrder();
    const theirs = twoLineOrder(other);
    const stock = getProduct(hoodie.id).variants.map((v) => v.stock);
    const state = await start(order);
    await confirm(order, state, razorpay.pay(state.checkout!.orderId));
    expect(getProduct(hoodie.id).variants.map((v) => v.stock)).toEqual(stock);
    expect(mine(other)).toMatchObject({ code: theirs.code, unpaidCents: 300000 });
  });
});
