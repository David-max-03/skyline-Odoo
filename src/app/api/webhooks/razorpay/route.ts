import { AppError } from "@/server/errors";
import { failure } from "@/server/http";
import { handleRazorpayWebhook } from "@/server/services/online-applications";

/**
 * Razorpay webhook. It does not use the shared route wrapper: the signature is
 * computed over the exact bytes received, so the body is read raw and never
 * parsed first, and the caller is Razorpay's server, not a browser session.
 *
 * Replies 200 once an event is handled or recognised as a repeat, so Razorpay
 * stops resending it; any other status makes Razorpay try again later.
 */

const MAX_BYTES = 256 * 1024;

const reply = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  try {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) {
      throw new AppError("too_large", "The webhook body is too large.", 413);
    }
    const rawBody = Buffer.from(await request.arrayBuffer());
    if (rawBody.length > MAX_BYTES) throw new AppError("too_large", "The webhook body is too large.", 413);

    const result = await handleRazorpayWebhook(
      rawBody,
      request.headers.get("x-razorpay-signature"),
      request.headers.get("x-razorpay-event-id"),
    );
    return reply({ data: result }, 200);
  } catch (error) {
    if (error instanceof AppError) {
      return reply({ error: { code: error.code, message: error.message } }, error.status);
    }
    // Includes "database unavailable" (503): Razorpay retries anything that is not a 2xx,
    // so a payment that could not be recorded now is delivered again later.
    return failure("POST", "/api/webhooks/razorpay", error);
  }
}
