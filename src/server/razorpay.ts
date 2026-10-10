import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors";

/**
 * Razorpay: configuration, signature checks and the handful of API calls the
 * membership flow needs. There is no SDK; the calls are plain HTTPS.
 *
 * Nothing in this file logs, returns or throws a credential. Messages name
 * the environment variable that is wrong, never its value.
 */

// --- configuration -------------------------------------------------------------

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  /** Needed only to accept webhooks. */
  webhookSecret: string | null;
  apiBase: string;
}

type ConfigCheck = { ok: true; config: RazorpayConfig } | { ok: false; problem: string };

const DEFAULT_API_BASE = "https://api.razorpay.com/v1";
const env = (name: string) => process.env[name]?.trim() || null;

/**
 * Reads and validates the configuration. Online payment is on only when
 * `SKYLINE_RAZORPAY_MODE=test` is set explicitly and the key is a test key.
 * A live key, or `live` mode, is refused: this version has no live mode.
 */
export function checkRazorpayConfig(): ConfigCheck {
  const mode = env("SKYLINE_RAZORPAY_MODE");
  const keyId = env("SKYLINE_RAZORPAY_KEY_ID");
  const keySecret = env("SKYLINE_RAZORPAY_KEY_SECRET");

  if (!mode) return { ok: false, problem: "SKYLINE_RAZORPAY_MODE is not set; online payment is off." };
  if (mode === "live") {
    return { ok: false, problem: "SKYLINE_RAZORPAY_MODE=live is not supported by this version. Only test mode is." };
  }
  if (mode !== "test") return { ok: false, problem: "SKYLINE_RAZORPAY_MODE must be `test`." };
  if (!keyId) return { ok: false, problem: "SKYLINE_RAZORPAY_KEY_ID is not set." };
  if (keyId.startsWith("rzp_live_")) {
    return { ok: false, problem: "SKYLINE_RAZORPAY_KEY_ID is a live key. Only test keys (rzp_test_…) are accepted." };
  }
  if (!/^rzp_test_[A-Za-z0-9]{6,}$/.test(keyId)) {
    return { ok: false, problem: "SKYLINE_RAZORPAY_KEY_ID is not a Razorpay test key (rzp_test_…)." };
  }
  if (!keySecret) return { ok: false, problem: "SKYLINE_RAZORPAY_KEY_SECRET is not set." };

  // The API address can be pointed at a stand-in on this machine, which is how
  // the end-to-end script runs without Razorpay. Anything but a loopback
  // address is refused, so credentials cannot be redirected to another host.
  let apiBase = DEFAULT_API_BASE;
  const override = env("SKYLINE_RAZORPAY_API_BASE");
  if (override) {
    let host: string | null = null;
    try {
      const url = new URL(override);
      host = url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null;
    } catch {
      host = null;
    }
    if (host !== "127.0.0.1" && host !== "localhost") {
      return { ok: false, problem: "SKYLINE_RAZORPAY_API_BASE may only point at 127.0.0.1 or localhost." };
    }
    apiBase = override.replace(/\/+$/, "");
  }

  return {
    ok: true,
    config: { keyId, keySecret, webhookSecret: env("SKYLINE_RAZORPAY_WEBHOOK_SECRET"), apiBase },
  };
}

export const razorpayConfigured = (): boolean => checkRazorpayConfig().ok;

/**
 * Whether an amount can be taken online right now: Razorpay is configured,
 * the organisation's currency is rupees, and the amount is at least
 * Razorpay's minimum of 100 paise.
 */
export function payableOnline(amountCents: number): boolean {
  return (
    checkRazorpayConfig().ok &&
    (process.env.NEXT_PUBLIC_CURRENCY ?? "INR") === "INR" &&
    Number.isInteger(amountCents) &&
    amountCents >= 100
  );
}

const warned = new Set<string>();

/** The configuration, or a 503 that says nothing about what is missing to the public. */
export function requireRazorpay(): RazorpayConfig {
  const check = checkRazorpayConfig();
  if (check.ok) return check.config;
  if (!warned.has(check.problem)) {
    warned.add(check.problem);
    console.warn(`[razorpay] ${check.problem}`);
  }
  throw new AppError("payments_not_configured", "Online payment is not set up yet.", 503);
}

// --- signatures ----------------------------------------------------------------

const hmacHex = (secret: string, message: string | Buffer) =>
  createHmac("sha256", secret).update(message).digest("hex");

function sameHex(expected: string, given: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(given)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(given.toLowerCase(), "hex"));
}

/** What Checkout signs on success: `order_id|payment_id` with the key secret. */
export const signCheckout = (keySecret: string, orderId: string, paymentId: string) =>
  hmacHex(keySecret, `${orderId}|${paymentId}`);

/** `orderId` must be the one this server stored, never one the browser sent. */
export function isValidCheckoutSignature(
  config: RazorpayConfig,
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  return sameHex(signCheckout(config.keySecret, orderId, paymentId), signature);
}

/** A webhook is signed over its exact bytes with the webhook secret. */
export const signWebhook = (webhookSecret: string, rawBody: string | Buffer) => hmacHex(webhookSecret, rawBody);

export function isValidWebhookSignature(webhookSecret: string, rawBody: Buffer, signature: string): boolean {
  return sameHex(signWebhook(webhookSecret, rawBody), signature);
}

// --- provider data -------------------------------------------------------------

export const RAZORPAY_ORDER_ID = /^order_[A-Za-z0-9]{6,40}$/;
export const RAZORPAY_PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/;

export interface GatewayOrder {
  id: string;
  amountCents: number;
  currency: string;
}

export interface GatewayPayment {
  id: string;
  orderId: string | null;
  amountCents: number;
  currency: string;
  /** created | authorized | captured | refunded | failed */
  status: string;
  /** upi | card | netbanking | wallet | emi | … */
  method: string | null;
  errorDescription: string | null;
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** Reads a Razorpay payment entity from an API reply or a webhook payload. */
export function toGatewayPayment(entity: unknown): GatewayPayment | null {
  if (!entity || typeof entity !== "object") return null;
  const e = entity as Record<string, unknown>;
  const id = str(e.id);
  if (!id || !RAZORPAY_PAYMENT_ID.test(id) || !Number.isInteger(e.amount)) return null;
  return {
    id,
    orderId: str(e.order_id),
    amountCents: e.amount as number,
    currency: str(e.currency) ?? "",
    status: str(e.status) ?? "",
    method: str(e.method),
    errorDescription: str(e.error_description),
  };
}

/** How a payment differs from the order this server created for it, or null when it matches. */
export function paymentMismatch(
  expected: { orderId: string; amountCents: number; currency: string },
  payment: GatewayPayment,
): "order" | "amount" | "currency" | null {
  if (payment.orderId !== expected.orderId) return "order";
  if (payment.amountCents !== expected.amountCents) return "amount";
  if (payment.currency !== expected.currency) return "currency";
  return null;
}

export interface PaymentGateway {
  createOrder(input: {
    amountCents: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  listOrderPayments(orderId: string): Promise<GatewayPayment[]>;
  capturePayment(paymentId: string, amountCents: number, currency: string): Promise<GatewayPayment>;
}

// --- HTTP gateway --------------------------------------------------------------

const unavailable = () =>
  new AppError("payment_provider_unavailable", "The payment provider could not be reached. Try again in a moment.", 502);

async function call(config: RazorpayConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(config.apiBase + path, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString("base64")}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    console.error(`[razorpay] ${method} ${path} did not complete`);
    throw unavailable();
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // Razorpay's own error code only. The request, with its credentials, is never logged.
    const error = (payload as { error?: { code?: unknown } } | null)?.error;
    console.error(`[razorpay] ${method} ${path} failed: ${response.status} ${str(error?.code) ?? ""}`.trim());
    if (response.status === 401) {
      throw new AppError("payments_not_configured", "Online payment is not set up correctly.", 503);
    }
    throw unavailable();
  }
  return payload;
}

function httpGateway(config: RazorpayConfig): PaymentGateway {
  const payment = (payload: unknown): GatewayPayment => {
    const parsed = toGatewayPayment(payload);
    if (!parsed) throw unavailable();
    return parsed;
  };
  const paymentPath = (paymentId: string) => {
    if (!RAZORPAY_PAYMENT_ID.test(paymentId)) throw unavailable();
    return `/payments/${paymentId}`;
  };
  return {
    async createOrder({ amountCents, currency, receipt, notes }) {
      const payload = (await call(config, "POST", "/orders", { amount: amountCents, currency, receipt, notes })) as
        | Record<string, unknown>
        | null;
      const id = str(payload?.id);
      if (!id || !RAZORPAY_ORDER_ID.test(id) || !Number.isInteger(payload?.amount)) throw unavailable();
      return { id, amountCents: payload!.amount as number, currency: str(payload!.currency) ?? "" };
    },
    async fetchPayment(paymentId) {
      return payment(await call(config, "GET", paymentPath(paymentId)));
    },
    async listOrderPayments(orderId) {
      if (!RAZORPAY_ORDER_ID.test(orderId)) throw unavailable();
      const payload = (await call(config, "GET", `/orders/${orderId}/payments`)) as { items?: unknown } | null;
      const items = Array.isArray(payload?.items) ? payload.items : [];
      return items.map(toGatewayPayment).filter((p): p is GatewayPayment => p !== null);
    },
    async capturePayment(paymentId, amountCents, currency) {
      return payment(await call(config, "POST", `${paymentPath(paymentId)}/capture`, { amount: amountCents, currency }));
    },
  };
}

// Tests replace the gateway so that no request ever leaves the machine.
const globalGateway = globalThis as unknown as { __skylineGateway?: PaymentGateway | null };

export function setGateway(gateway: PaymentGateway | null): void {
  globalGateway.__skylineGateway = gateway;
}

export function getGateway(): PaymentGateway {
  const config = requireRazorpay();
  return globalGateway.__skylineGateway ?? httpGateway(config);
}
