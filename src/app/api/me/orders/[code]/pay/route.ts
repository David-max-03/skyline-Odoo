import { orderPaymentActionSchema } from "@/lib/contracts";
import { LIMITS, shopperRoute } from "@/server/http";
import { orderPaymentAction } from "@/server/services/order-payments";

/**
 * Pay one of the signed-in member's own orders online (a committee account
 * linked to a member record pays that member's orders): `start` a payment,
 * `confirm` a Checkout result, `check` with Razorpay, or note a `failed`
 * attempt. The member comes from the session and the amount from the order;
 * the body carries neither. An order is marked paid only after the server has
 * verified the payment with Razorpay.
 */
export const POST = shopperRoute({ body: orderPaymentActionSchema, limit: LIMITS.onlineAction }, ({ body, params, memberId }) =>
  orderPaymentAction(memberId, params.code, body),
);
