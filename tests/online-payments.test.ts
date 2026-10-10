import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SETTINGS,
  applicationInputSchema,
  memberInputSchema,
  onlineApplicationInputSchema,
  type OnlineApplicationStart,
} from "@/lib/contracts";
import { completeSetup, inspectSetupToken, login } from "@/server/auth";
import { all, get, setClock } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  checkRazorpayConfig,
  setGateway,
  signCheckout,
  signWebhook,
  type GatewayOrder,
  type GatewayPayment,
  type PaymentGateway,
} from "@/server/razorpay";
import { getApplicationStatus, listApplications, paymentInstructions, submitApplication } from "@/server/services/applications";
import { listTransactions } from "@/server/services/finance";
import { createMember, listMembers, updateMember } from "@/server/services/members";
import {
  handleRazorpayWebhook,
  listOnlinePayments,
  onlineApplicationAction,
  reconcileOnlinePayment,
  startOnlineApplication,
} from "@/server/services/online-applications";
import { freshDb, type Staff } from "./helpers";

/**
 * Every Razorpay reply here comes from `FakeRazorpay`. No test makes a
 * network request, and the keys below are made up.
 */

const KEY_ID = "rzp_test_UnitTestKey0001";
const KEY_SECRET = "unit-test-key-secret";
const WEBHOOK_SECRET = "unit-test-webhook-secret";
const RAZORPAY_ENV = [
  "SKYLINE_RAZORPAY_MODE",
  "SKYLINE_RAZORPAY_KEY_ID",
  "SKYLINE_RAZORPAY_KEY_SECRET",
  "SKYLINE_RAZORPAY_WEBHOOK_SECRET",
  "SKYLINE_RAZORPAY_API_BASE",
] as const;

class FakeRazorpay implements PaymentGateway {
  orders: GatewayOrder[] = [];
  payments = new Map<string, GatewayPayment>();
  captures = 0;
  down = false;
  private n = 0;
  private id = (prefix: string) => `${prefix}_Test${String(++this.n).padStart(10, "0")}`;
  private check() {
    if (this.down) throw new AppError("payment_provider_unavailable", "down", 502);
  }

  async createOrder(input: { amountCents: number; currency: string }): Promise<GatewayOrder> {
    this.check();
    const order = { id: this.id("order"), amountCents: input.amountCents, currency: input.currency };
    this.orders.push(order);
    return order;
  }
  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    this.check();
    const payment = this.payments.get(paymentId);
    if (!payment) throw new AppError("payment_provider_unavailable", "no such payment", 502);
    return { ...payment };
  }
  async listOrderPayments(orderId: string): Promise<GatewayPayment[]> {
    this.check();
    return [...this.payments.values()].filter((p) => p.orderId === orderId).map((p) => ({ ...p }));
  }
  async capturePayment(paymentId: string): Promise<GatewayPayment> {
    this.check();
    this.captures += 1;
    const payment = this.payments.get(paymentId)!;
    payment.status = "captured";
    return { ...payment };
  }

  /** What Razorpay would hold after the applicant pays (or tries to pay) an order. */
  pay(orderId: string, overrides: Partial<GatewayPayment> = {}): GatewayPayment {
    const order = this.orders.find((o) => o.id === orderId);
    const payment: GatewayPayment = {
      id: this.id("pay"),
      orderId,
      amountCents: order?.amountCents ?? SETTINGS.membershipFeeCents,
      currency: order?.currency ?? "INR",
      status: "captured",
      method: "upi",
      errorDescription: null,
      ...overrides,
    };
    this.payments.set(payment.id, payment);
    return payment;
  }
}

let staff: Staff;
let razorpay: FakeRazorpay;

beforeEach(() => {
  staff = freshDb();
  razorpay = new FakeRazorpay();
  setGateway(razorpay);
  process.env.SKYLINE_RAZORPAY_MODE = "test";
  process.env.SKYLINE_RAZORPAY_KEY_ID = KEY_ID;
  process.env.SKYLINE_RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.SKYLINE_RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  delete process.env.SKYLINE_RAZORPAY_API_BASE;
});

afterEach(() => {
  setGateway(null);
  setClock(null);
  for (const name of RAZORPAY_ENV) delete process.env[name];
});

const applicant = (n: number) =>
  onlineApplicationInputSchema.parse({ name: `Applicant ${n}`, email: `applicant${n}@campus.example`, phone: "9999900000" });

const start = (n = 1) => startOnlineApplication(applicant(n));

/** The browser returning from Checkout with a correctly signed result. */
const confirm = (app: OnlineApplicationStart, payment: GatewayPayment, signature?: string) =>
  onlineApplicationAction(app.id, {
    action: "confirm",
    token: app.accessToken,
    razorpayOrderId: app.checkout!.orderId,
    razorpayPaymentId: payment.id,
    razorpaySignature: signature ?? signCheckout(KEY_SECRET, app.checkout!.orderId, payment.id),
  });

const resume = (app: OnlineApplicationStart) =>
  onlineApplicationAction(app.id, { action: "resume", token: app.accessToken });

let eventCounter = 0;
function webhook(type: string, payment: GatewayPayment, options: { eventId?: string; secret?: string } = {}) {
  const body = Buffer.from(
    JSON.stringify({
      entity: "event",
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
  return handleRazorpayWebhook(
    body,
    signWebhook(options.secret ?? WEBHOOK_SECRET, body),
    options.eventId ?? `evt_${++eventCounter}`,
  );
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

const dues = () => listTransactions().filter((t) => t.category === "dues");
const onlineRow = (id: string) =>
  get<{ status: string; razorpay_payment_id: string | null; member_id: string | null; verified_via: string | null }>(
    "SELECT status, razorpay_payment_id, member_id, verified_via FROM online_applications WHERE id = ?",
    id,
  )!;
const nothingActivated = () => {
  expect(listMembers()).toHaveLength(0);
  expect(listTransactions()).toHaveLength(0);
  expect(get("SELECT 1 FROM membership_applications")).toBeUndefined();
  expect(get("SELECT 1 FROM account_setup_tokens")).toBeUndefined();
};
const tokenOf = (path: string) => path.split("/").pop()!;

describe("configuration", () => {
  it("is off until test mode is set explicitly, and says so without leaking anything", async () => {
    delete process.env.SKYLINE_RAZORPAY_MODE;
    expect(checkRazorpayConfig().ok).toBe(false);
    expect((await paymentInstructions()).online.available).toBe(false);
    const error = await rejection(start());
    expect(error).toMatchObject({ code: "payments_not_configured", status: 503 });
    expect(error.message).not.toContain(KEY_SECRET);
    expect(razorpay.orders).toHaveLength(0);
  });

  it("refuses live mode and live keys", () => {
    process.env.SKYLINE_RAZORPAY_MODE = "live";
    expect(checkRazorpayConfig().ok).toBe(false);
    process.env.SKYLINE_RAZORPAY_MODE = "test";
    process.env.SKYLINE_RAZORPAY_KEY_ID = "rzp_live_RealLookingKey01";
    expect(checkRazorpayConfig().ok).toBe(false);
    process.env.SKYLINE_RAZORPAY_KEY_ID = KEY_ID;
    delete process.env.SKYLINE_RAZORPAY_KEY_SECRET;
    expect(checkRazorpayConfig().ok).toBe(false);
  });

  it("never puts a credential in a configuration message", () => {
    const secret = "do-not-print-this-secret";
    const cases: Record<string, string | undefined>[] = [
      { SKYLINE_RAZORPAY_MODE: "live" },
      { SKYLINE_RAZORPAY_MODE: "prod" },
      { SKYLINE_RAZORPAY_KEY_ID: "rzp_live_RealLookingKey01" },
      { SKYLINE_RAZORPAY_KEY_ID: "nonsense" },
      { SKYLINE_RAZORPAY_API_BASE: "https://evil.example/v1" },
    ];
    for (const overrides of cases) {
      process.env.SKYLINE_RAZORPAY_MODE = "test";
      process.env.SKYLINE_RAZORPAY_KEY_ID = KEY_ID;
      process.env.SKYLINE_RAZORPAY_KEY_SECRET = secret;
      delete process.env.SKYLINE_RAZORPAY_API_BASE;
      Object.assign(process.env, overrides);
      const check = checkRazorpayConfig();
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.problem).not.toContain(secret);
        expect(check.problem).not.toContain("RealLookingKey01");
      }
    }
  });

  it("only lets the API address point at this machine", () => {
    process.env.SKYLINE_RAZORPAY_API_BASE = "http://127.0.0.1:9999/v1";
    expect(checkRazorpayConfig().ok).toBe(true);
    process.env.SKYLINE_RAZORPAY_API_BASE = "https://api.razorpay.com.evil.example/v1";
    expect(checkRazorpayConfig().ok).toBe(false);
  });
});

describe("starting an online application", () => {
  it("creates an order and a pending application, and nothing else", async () => {
    expect((await paymentInstructions()).online.available).toBe(true);
    const app = await start();
    expect(app.status).toBe("pending");
    expect(app.code).toMatch(/^APP-[2-9A-Z]{6}$/);
    expect(app.checkout).toMatchObject({
      keyId: KEY_ID,
      orderId: razorpay.orders[0].id,
      amountCents: SETTINGS.membershipFeeCents,
      currency: "INR",
    });
    expect(app.setup).toBeNull();
    expect(razorpay.orders).toEqual([
      { id: app.checkout!.orderId, amountCents: SETTINGS.membershipFeeCents, currency: "INR" },
    ]);
    nothingActivated();
    expect(getApplicationStatus(app.code, "applicant1@campus.example")).toMatchObject({
      status: "pending",
      online: "pending",
      memberNo: null,
    });
  });

  it("keeps the key secret and the access token out of what is sent and stored", async () => {
    const app = await start();
    expect(JSON.stringify(app)).not.toContain(KEY_SECRET);
    expect(JSON.stringify(app)).not.toContain(WEBHOOK_SECRET);
    const stored = JSON.stringify(all("SELECT * FROM online_applications"));
    expect(stored).not.toContain(app.accessToken);
    expect(stored).not.toContain(KEY_SECRET);
  });

  it("refuses someone who is already a member or already has a manual application waiting", async () => {
    createMember(memberInputSchema.parse({ name: "Existing", email: "applicant1@campus.example", duesPaid: true }), staff.treasurer);
    expect(await rejection(start(1))).toMatchObject({ code: "already_member" });

    submitApplication(
      applicationInputSchema.parse({ name: "Manual", email: "applicant2@campus.example", paymentMethod: "cash", paymentReference: "Paid Tariq" }),
      null,
    );
    expect(await rejection(start(2))).toMatchObject({ code: "application_pending" });
    expect(razorpay.orders).toHaveLength(0);
  });

  it("refuses a signed-in member, whatever email they give, on both routes", async () => {
    const member = createMember(memberInputSchema.parse({ name: "Signed In", email: "signedin@campus.example", duesPaid: true }), staff.treasurer);
    const session: typeof staff.admin = {
      id: member.id,
      name: member.name,
      email: member.email,
      role: "member",
      memberId: member.id,
      memberNo: member.memberNo,
    };
    expect(await rejection(startOnlineApplication(applicant(5), session))).toMatchObject({ code: "already_member", status: 409 });
    const manual = applicationInputSchema.parse({ name: "Other", email: "other@campus.example", paymentMethod: "cash", paymentReference: "Paid Tariq" });
    expect(thrown(() => submitApplication(manual, null, session)).code).toBe("already_member");

    expect(razorpay.orders).toHaveLength(0);
    expect(listMembers()).toHaveLength(1);
    expect(get("SELECT 1 FROM online_applications")).toBeUndefined();
    expect(get("SELECT 1 FROM membership_applications")).toBeUndefined();
    // A visitor and a committee account are unaffected.
    expect((await startOnlineApplication(applicant(6), null)).status).toBe("pending");
    expect(submitApplication(manual, null, staff.treasurer).status).toBe("pending");
  });

  it("says when the password is set, so a finished application stops being shown", async () => {
    const app = await start();
    const done = await confirm(app, razorpay.pay(app.checkout!.orderId));
    expect(done.passwordSet).toBe(false);
    completeSetup(tokenOf(done.setup!.path), "correct-horse-battery");

    const revisited = await resume(app);
    expect(revisited).toMatchObject({ status: "activated", passwordSet: true, setup: null, canRequestLink: false });
    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1);
    expect(razorpay.orders).toHaveLength(1);
  });

  it("needs the access token for every action", async () => {
    const app = await start();
    const error = await rejection(onlineApplicationAction(app.id, { action: "resume", token: "x".repeat(43) }));
    expect(error).toMatchObject({ code: "not_found", status: 404 });
    expect(await rejection(onlineApplicationAction("oap_missing", { action: "resume", token: app.accessToken }))).toMatchObject({
      code: "not_found",
    });
  });
});

describe("verifying a payment", () => {
  it("creates the member, the ledger entry and the password link once the payment checks out", async () => {
    const app = await start();
    const payment = razorpay.pay(app.checkout!.orderId);
    const done = await confirm(app, payment);

    expect(done).toMatchObject({ status: "activated", memberNo: "SKY-M-0001", checkout: null, processing: false });
    const [member] = listMembers();
    expect(member).toMatchObject({ email: "applicant1@campus.example", status: "active", duesOwedCents: 0, hasAccount: false });

    const ledger = dues();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      status: "settled",
      amountCents: SETTINGS.membershipFeeCents,
      method: "upi",
      source: "dues",
    });
    expect(ledger[0].description).toContain(payment.id);

    const [application] = listApplications(staff.treasurer);
    expect(application).toMatchObject({
      status: "approved",
      channel: "razorpay",
      code: app.code,
      paymentReference: payment.id,
      memberNo: "SKY-M-0001",
      reviewedByName: null,
    });
    expect(onlineRow(app.id)).toMatchObject({ status: "activated", razorpay_payment_id: payment.id, verified_via: "checkout" });
    expect(getApplicationStatus(app.code, "applicant1@campus.example")).toMatchObject({ status: "approved", memberNo: "SKY-M-0001" });

    // The link belongs to this member, works once, and is stored only as a hash.
    const token = tokenOf(done.setup!.path);
    expect(done.setup).toMatchObject({ memberNo: "SKY-M-0001", email: "applicant1@campus.example" });
    expect(inspectSetupToken(token).memberNo).toBe("SKY-M-0001");
    expect(JSON.stringify(all("SELECT * FROM account_setup_tokens"))).not.toContain(token);
    completeSetup(token, "correct-horse-battery");
    expect(thrown(() => completeSetup(token, "another-long-password")).code).toBe("invalid_link");
    expect(login("applicant1@campus.example", "correct-horse-battery").user.role).toBe("member");
  });

  it("rejects a wrong signature", async () => {
    const app = await start();
    const payment = razorpay.pay(app.checkout!.orderId);
    for (const signature of [
      signCheckout("some-other-secret", app.checkout!.orderId, payment.id),
      signCheckout(KEY_SECRET, "order_Somebody0001", payment.id),
      "0".repeat(64),
    ]) {
      expect(await rejection(confirm(app, payment, signature))).toMatchObject({ code: "payment_unverified", status: 400 });
    }
    nothingActivated();
    expect(onlineRow(app.id).status).toBe("pending");
  });

  it("does not take a payment ID from the browser as proof", async () => {
    const app = await start();
    // Correctly signed, but Razorpay says the payment never completed.
    const created = razorpay.pay(app.checkout!.orderId, { status: "created" });
    expect(await confirm(app, created)).toMatchObject({ status: "pending", processing: true, setup: null, memberNo: null });
    // Correctly signed, but Razorpay has no such payment at all.
    const ghost: GatewayPayment = { ...created, id: "pay_Test9999999999" };
    expect((await rejection(confirm(app, ghost))).code).toBe("payment_provider_unavailable");
    nothingActivated();
  });

  it("rejects a payment whose amount or currency differs from the order", async () => {
    const app = await start();
    const short = razorpay.pay(app.checkout!.orderId, { amountCents: 100 });
    expect(await rejection(confirm(app, short))).toMatchObject({ code: "payment_mismatch", status: 409 });
    const dollars = razorpay.pay(app.checkout!.orderId, { currency: "USD" });
    expect(await rejection(confirm(app, dollars))).toMatchObject({ code: "payment_mismatch" });
    nothingActivated();
    expect(onlineRow(app.id)).toMatchObject({ status: "pending", razorpay_payment_id: null });
  });

  it("cannot use one payment for a second membership", async () => {
    const first = await start(1);
    const second = await start(2);
    const payment = razorpay.pay(first.checkout!.orderId);
    await confirm(first, payment);

    // The second applicant presents the first applicant's payment, signed for their own order.
    expect(await rejection(confirm(second, payment))).toMatchObject({ code: "payment_mismatch" });
    expect(onlineRow(second.id)).toMatchObject({ status: "pending", razorpay_payment_id: null, member_id: null });
    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1);
  });

  it("captures a payment that Razorpay has only authorised, for the exact amount", async () => {
    const app = await start();
    const payment = razorpay.pay(app.checkout!.orderId, { status: "authorized", method: "card" });
    expect((await confirm(app, payment)).status).toBe("activated");
    expect(razorpay.captures).toBe(1);
    expect(dues()[0]).toMatchObject({ status: "settled", method: "card" });
    // The application row's own list has no "card"; the channel says how it was paid.
    expect(listApplications(staff.treasurer)[0]).toMatchObject({ paymentMethod: "bank", channel: "razorpay" });
  });

  it("is safe to confirm twice: one member, one ledger entry, one automatic link", async () => {
    const app = await start();
    const payment = razorpay.pay(app.checkout!.orderId);
    const [a, b] = await Promise.all([confirm(app, payment), confirm(app, payment)]);
    const again = await confirm(app, payment);

    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1);
    expect(all("SELECT 1 FROM membership_applications")).toHaveLength(1);
    expect([a.setup, b.setup, again.setup].filter(Boolean)).toHaveLength(1);
    expect(again).toMatchObject({ status: "activated", setup: null, canRequestLink: true });
  });
});

describe("failed, cancelled and pending payments", () => {
  it("does not activate on a failed payment, and lets the same order be paid again", async () => {
    const app = await start();
    const failed = razorpay.pay(app.checkout!.orderId, { status: "failed", errorDescription: "Payment was declined by the bank" });
    const afterFailure = await confirm(app, failed);
    expect(afterFailure).toMatchObject({ status: "failed", failureReason: "Payment was declined by the bank", setup: null });
    expect(afterFailure.checkout?.orderId).toBe(app.checkout!.orderId);
    nothingActivated();

    const paid = razorpay.pay(app.checkout!.orderId);
    expect((await confirm(app, paid)).status).toBe("activated");
    expect(razorpay.orders).toHaveLength(1);
    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1);
  });

  it("treats a closed Checkout window as nothing more than a note", async () => {
    const app = await start();
    const state = await onlineApplicationAction(app.id, { action: "failed", token: app.accessToken, reason: "Payment window closed" });
    expect(state).toMatchObject({ status: "failed", failureReason: "Payment window closed" });
    expect(state.checkout?.orderId).toBe(app.checkout!.orderId);
    nothingActivated();
  });

  it("keeps a payment that is still processing from activating anything", async () => {
    const app = await start();
    razorpay.pay(app.checkout!.orderId, { status: "created" });
    expect(await resume(app)).toMatchObject({ status: "pending", setup: null });
    nothingActivated();
  });

  it("does not record a failure reported by a webhook after the payment was captured", async () => {
    const app = await start();
    const payment = razorpay.pay(app.checkout!.orderId);
    await confirm(app, payment);
    const late = { ...payment, id: "pay_Test0000000777", status: "failed", errorDescription: "late" };
    expect(webhook("payment.failed", late).outcome).toBe("ignored_already_paid");
    expect(onlineRow(app.id).status).toBe("activated");
  });

  it("accepts a capture that arrives after a failure", async () => {
    const app = await start();
    const failed = razorpay.pay(app.checkout!.orderId, { status: "failed", errorDescription: "Timed out" });
    expect(webhook("payment.failed", failed).outcome).toBe("marked_failed");
    expect(onlineRow(app.id).status).toBe("failed");
    nothingActivated();
    expect(webhook("payment.captured", razorpay.pay(app.checkout!.orderId)).outcome).toBe("recorded");
    expect(onlineRow(app.id).status).toBe("activated");
    expect(listMembers()).toHaveLength(1);
  });
});

describe("webhooks", () => {
  it("activates from a signed webhook when the browser never returns", async () => {
    const app = await start();
    const payment = razorpay.pay(app.checkout!.orderId);
    expect(webhook("payment.captured", payment).outcome).toBe("recorded");
    expect(onlineRow(app.id)).toMatchObject({ status: "activated", verified_via: "webhook" });
    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1);
    // No link was handed to anyone: the webhook caller is not the applicant.
    expect(get("SELECT 1 FROM account_setup_tokens")).toBeUndefined();
  });

  it("rejects a bad or missing signature and a body changed after signing", async () => {
    const app = await start();
    const payment = razorpay.pay(app.checkout!.orderId);
    expect(thrown(() => webhook("payment.captured", payment, { secret: "not-the-secret" }))).toMatchObject({
      code: "bad_signature",
      status: 401,
    });
    const body = Buffer.from(JSON.stringify({ event: "payment.captured", payload: {} }));
    expect(thrown(() => handleRazorpayWebhook(body, null, "evt_x")).code).toBe("bad_signature");
    const signature = signWebhook(WEBHOOK_SECRET, body);
    const tampered = Buffer.from(body.toString().replace("captured", "captured "));
    expect(thrown(() => handleRazorpayWebhook(tampered, signature, "evt_y")).code).toBe("bad_signature");
    nothingActivated();
    expect(get("SELECT 1 FROM razorpay_webhook_events")).toBeUndefined();
  });

  it("refuses webhooks when no webhook secret is configured", async () => {
    const app = await start();
    delete process.env.SKYLINE_RAZORPAY_WEBHOOK_SECRET;
    const payment = razorpay.pay(app.checkout!.orderId);
    expect(thrown(() => webhook("payment.captured", payment))).toMatchObject({ code: "payments_not_configured", status: 503 });
    nothingActivated();
  });

  it("handles the same event delivered twice, and two events for one payment", async () => {
    const app = await start();
    const payment = razorpay.pay(app.checkout!.orderId);
    expect(webhook("payment.captured", payment, { eventId: "evt_same" }).outcome).toBe("recorded");
    expect(webhook("payment.captured", payment, { eventId: "evt_same" }).outcome).toBe("duplicate");
    expect(webhook("order.paid", payment, { eventId: "evt_other" }).outcome).toBe("already_recorded");

    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1);
    expect(all("SELECT 1 FROM membership_applications")).toHaveLength(1);
    expect(all("SELECT 1 FROM razorpay_webhook_events")).toHaveLength(2);
  });

  it("does nothing for a payment whose amount is wrong, an uncaptured one, or an order it does not know", async () => {
    const app = await start();
    const short = razorpay.pay(app.checkout!.orderId, { amountCents: 1 });
    expect(webhook("payment.captured", short).outcome).toBe("rejected_amount_mismatch");
    const authorised = razorpay.pay(app.checkout!.orderId, { status: "authorized" });
    expect(webhook("payment.captured", authorised).outcome).toBe("ignored_not_captured");
    const stranger = razorpay.pay("order_Test0000009999");
    expect(webhook("payment.captured", stranger).outcome).toBe("ignored_unknown_order");
    nothingActivated();
    expect(onlineRow(app.id)).toMatchObject({ status: "pending", razorpay_payment_id: null });
  });

  it("lets the applicant collect the link when the webhook arrived first", async () => {
    const app = await start();
    const payment = razorpay.pay(app.checkout!.orderId);
    webhook("payment.captured", payment);

    const back = await confirm(app, payment);
    expect(back).toMatchObject({ status: "activated", memberNo: "SKY-M-0001" });
    expect(back.setup?.memberNo).toBe("SKY-M-0001");
    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1);
  });
});

describe("recovery after the browser closes", () => {
  it("finds the payment at Razorpay when the applicant comes back", async () => {
    const app = await start();
    razorpay.pay(app.checkout!.orderId); // paid, but the browser closed before confirming

    nothingActivated();
    const back = await resume(app);
    expect(back).toMatchObject({ status: "activated", memberNo: "SKY-M-0001" });
    expect(back.setup).not.toBeNull();
    expect(onlineRow(app.id).verified_via).toBe("lookup");

    // Reloading does not cancel the link the applicant is holding.
    const reloaded = await resume(app);
    expect(reloaded.setup).toBeNull();
    expect(inspectSetupToken(tokenOf(back.setup!.path)).memberNo).toBe("SKY-M-0001");
    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1);
  });

  it("still shows what it knows when Razorpay cannot be reached", async () => {
    const app = await start();
    razorpay.down = true;
    expect(await resume(app)).toMatchObject({ status: "pending", setup: null });
  });

  it("does not take a second payment from someone who paid and then applied again", async () => {
    const app = await start();
    razorpay.pay(app.checkout!.orderId);

    expect(await rejection(start())).toMatchObject({ code: "already_paid" });
    expect(razorpay.orders).toHaveLength(1);
    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1);
    expect(onlineRow(app.id).status).toBe("activated");
  });

  it("replaces an unpaid attempt when the person starts again, and still honours a late payment on it", async () => {
    const first = await start();
    const second = await start();
    expect(onlineRow(first.id).status).toBe("superseded");
    expect(second.checkout!.orderId).not.toBe(first.checkout!.orderId);
    expect((await resume(first)).checkout).toBeNull();

    webhook("payment.captured", razorpay.pay(first.checkout!.orderId));
    expect(onlineRow(first.id).status).toBe("activated");

    // Paying the newer order as well cannot create a second member: it is held for a refund.
    webhook("payment.captured", razorpay.pay(second.checkout!.orderId));
    expect(onlineRow(second.id).status).toBe("needs_review");
    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1);
  });

  it("gives a replacement link only to the token holder, and only until a password is set", async () => {
    const app = await start();
    const done = await confirm(app, razorpay.pay(app.checkout!.orderId));
    const firstToken = tokenOf(done.setup!.path);

    expect(await rejection(onlineApplicationAction(app.id, { action: "new_link", token: "y".repeat(43) }))).toMatchObject({
      code: "not_found",
    });
    const replaced = await onlineApplicationAction(app.id, { action: "new_link", token: app.accessToken });
    const secondToken = tokenOf(replaced.setup!.path);
    expect(thrown(() => inspectSetupToken(firstToken)).code).toBe("invalid_link");

    completeSetup(secondToken, "correct-horse-battery");
    expect(await rejection(onlineApplicationAction(app.id, { action: "new_link", token: app.accessToken }))).toMatchObject({
      code: "link_unavailable",
    });
    expect((await resume(app)).canRequestLink).toBe(false);
  });

  it("stops handing out links from the browser once the payment is old", async () => {
    const app = await start();
    webhook("payment.captured", razorpay.pay(app.checkout!.orderId));
    setClock(() => new Date(Date.now() + 73 * 3_600_000));
    expect(await resume(app)).toMatchObject({ status: "activated", setup: null, canRequestLink: false });
  });
});

describe("conflicts and reconciliation", () => {
  /** An applicant whose email is added to the member list by hand while they are paying. */
  async function paidButTaken() {
    const app = await start();
    const existing = createMember(
      memberInputSchema.parse({ name: "Added By Hand", email: "applicant1@campus.example", duesPaid: true }),
      staff.treasurer,
    );
    const payment = razorpay.pay(app.checkout!.orderId);
    const state = await confirm(app, payment);
    return { app, existing, payment, state };
  }

  it("keeps the payment on record and creates nothing twice when the email is already a member", async () => {
    const { app, payment, state } = await paidButTaken();
    expect(state).toMatchObject({ status: "needs_review", setup: null, memberNo: null, checkout: null });
    expect(onlineRow(app.id)).toMatchObject({ status: "needs_review", razorpay_payment_id: payment.id, member_id: null });

    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1); // the hand-added member's own dues, nothing from Razorpay
    expect(dues()[0].description).not.toContain(payment.id);
    expect(all("SELECT 1 FROM membership_applications")).toHaveLength(0);

    const [review] = listOnlinePayments(staff.treasurer);
    expect(review).toMatchObject({ status: "needs_review", razorpayPaymentId: payment.id, amountCents: SETTINGS.membershipFeeCents });
    expect(review.reviewReason).toContain("already belongs to a member");

    // A repeat webhook and a second application change nothing.
    expect(webhook("payment.captured", payment).outcome).toBe("already_recorded");
    expect(await rejection(start())).toMatchObject({ code: "already_member" });
    expect(listMembers()).toHaveLength(1);
  });

  it("lets a reviewer record a refund, with a note, and only once", async () => {
    const { app } = await paidButTaken();
    expect((await rejection(reconcileOnlinePayment(app.id, { action: "activate" }, staff.treasurer))).code).toBe("cannot_activate");

    const result = await reconcileOnlinePayment(app.id, { action: "refunded", note: "Refunded in the dashboard" }, staff.treasurer);
    expect(result.payment).toMatchObject({ status: "refunded", resolutionNote: "Refunded in the dashboard", resolvedByName: "Treasurer" });
    expect(result.setup).toBeNull();
    expect((await rejection(reconcileOnlinePayment(app.id, { action: "refunded", note: "again" }, staff.treasurer))).code).toBe("not_in_review");
    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1);
  });

  it("lets a reviewer finish the membership once the conflict is gone, without another payment", async () => {
    const { app, existing, payment } = await paidButTaken();
    updateMember(existing.id, { name: existing.name, email: "someone.else@campus.example", studentId: null, phone: null }, staff.admin);

    const result = await reconcileOnlinePayment(app.id, { action: "activate" }, staff.treasurer);
    expect(result.payment).toMatchObject({ status: "activated", memberNo: "SKY-M-0002", resolvedByName: "Treasurer" });
    expect(result.setup).toMatchObject({ memberNo: "SKY-M-0002", email: "applicant1@campus.example" });
    expect(listMembers()).toHaveLength(2);
    expect(dues().filter((t) => t.description.includes(payment.id))).toHaveLength(1);
    expect(razorpay.orders).toHaveLength(1);

    expect((await rejection(reconcileOnlinePayment(app.id, { action: "activate" }, staff.treasurer))).code).toBe("not_in_review");
    expect(listMembers()).toHaveLength(2);
  });

  it("lets a reviewer check an unpaid-looking application against Razorpay", async () => {
    const app = await start();
    expect((await rejection(reconcileOnlinePayment(app.id, { action: "check" }, staff.treasurer))).code).toBe("not_paid");
    nothingActivated();

    razorpay.pay(app.checkout!.orderId);
    const result = await reconcileOnlinePayment(app.id, { action: "check" }, staff.admin);
    expect(result.payment).toMatchObject({ status: "activated", memberNo: "SKY-M-0001", verifiedVia: "lookup" });
    expect(result.setup?.memberNo).toBe("SKY-M-0001");
    expect((await rejection(reconcileOnlinePayment(app.id, { action: "check" }, staff.admin))).code).toBe("already_paid");
    expect(listMembers()).toHaveLength(1);
    expect(dues()).toHaveLength(1);
  });

  it("is closed to everyone but the treasurer and president", async () => {
    const app = await start();
    const member: typeof staff.admin = { ...staff.organizer, role: "member" };
    for (const actor of [staff.organizer, member]) {
      expect(thrown(() => listOnlinePayments(actor)).code).toBe("forbidden");
      expect((await rejection(reconcileOnlinePayment(app.id, { action: "check" }, actor))).code).toBe("forbidden");
    }
    expect(thrown(() => listOnlinePayments(null)).code).toBe("unauthorized");
    expect((await rejection(reconcileOnlinePayment(app.id, { action: "check" }, null))).code).toBe("unauthorized");
  });
});

describe("the manual route alongside", () => {
  it("still files a pending application that only a reviewer can approve", async () => {
    const receipt = submitApplication(
      applicationInputSchema.parse({ name: "Cash Payer", email: "cash@campus.example", paymentMethod: "cash", paymentReference: "Paid Tariq" }),
      null,
    );
    expect(receipt.status).toBe("pending");
    expect(listApplications(staff.treasurer)[0]).toMatchObject({ channel: "manual", status: "pending" });
    expect(getApplicationStatus(receipt.code, "cash@campus.example")).toMatchObject({ status: "pending", online: null });
    expect(listMembers()).toHaveLength(0);
  });
});
