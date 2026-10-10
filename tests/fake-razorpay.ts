import { AppError } from "@/server/errors";
import { setGateway, type GatewayOrder, type GatewayPayment, type PaymentGateway } from "@/server/razorpay";

/**
 * A stand-in for Razorpay's API, held in memory. Tests that use it make no
 * network request, and the keys below are made up.
 */

export const KEY_ID = "rzp_test_UnitTestKey0001";
export const KEY_SECRET = "unit-test-key-secret";
export const WEBHOOK_SECRET = "unit-test-webhook-secret";

const RAZORPAY_ENV = [
  "SKYLINE_RAZORPAY_MODE",
  "SKYLINE_RAZORPAY_KEY_ID",
  "SKYLINE_RAZORPAY_KEY_SECRET",
  "SKYLINE_RAZORPAY_WEBHOOK_SECRET",
  "SKYLINE_RAZORPAY_API_BASE",
] as const;

export class FakeRazorpay implements PaymentGateway {
  orders: (GatewayOrder & { receipt: string })[] = [];
  payments = new Map<string, GatewayPayment>();
  captures = 0;
  /** Every call fails, as when Razorpay cannot be reached. */
  down = false;
  /** Capturing an authorised payment fails. */
  captureFails = false;
  private n = 0;
  private id = (prefix: string) => `${prefix}_Test${String(++this.n).padStart(10, "0")}`;
  private check() {
    if (this.down) throw new AppError("payment_provider_unavailable", "down", 502);
  }

  async createOrder(input: { amountCents: number; currency: string; receipt: string }): Promise<GatewayOrder> {
    this.check();
    const order = { id: this.id("order"), amountCents: input.amountCents, currency: input.currency, receipt: input.receipt };
    this.orders.push(order);
    return { id: order.id, amountCents: order.amountCents, currency: order.currency };
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
    if (this.captureFails) throw new AppError("payment_provider_unavailable", "capture failed", 502);
    this.captures += 1;
    const payment = this.payments.get(paymentId)!;
    payment.status = "captured";
    return { ...payment };
  }

  /** What Razorpay would hold after someone pays (or tries to pay) an order. */
  pay(orderId: string, overrides: Partial<GatewayPayment> = {}): GatewayPayment {
    const order = this.orders.find((o) => o.id === orderId);
    const payment: GatewayPayment = {
      id: this.id("pay"),
      orderId,
      amountCents: order?.amountCents ?? 0,
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

/** Turns Razorpay test mode on with made-up keys and routes every call to a new fake. */
export function useFakeRazorpay(): FakeRazorpay {
  const fake = new FakeRazorpay();
  setGateway(fake);
  process.env.SKYLINE_RAZORPAY_MODE = "test";
  process.env.SKYLINE_RAZORPAY_KEY_ID = KEY_ID;
  process.env.SKYLINE_RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.SKYLINE_RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  delete process.env.SKYLINE_RAZORPAY_API_BASE;
  return fake;
}

export function clearFakeRazorpay(): void {
  setGateway(null);
  for (const name of RAZORPAY_ENV) delete process.env[name];
}
