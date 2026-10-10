import { onlineApplicationActionSchema } from "@/lib/contracts";
import { LIMITS, publicRoute } from "@/server/http";
import { onlineApplicationAction } from "@/server/services/online-applications";

/**
 * The applicant's own application: `confirm` a Checkout result, `resume` after
 * leaving, note a `failed` attempt, or ask for a `new_link`. Every action needs
 * the access token from the start call. The password link is only ever in the
 * reply once the server has verified the payment with Razorpay.
 */
export const POST = publicRoute({ body: onlineApplicationActionSchema, limit: LIMITS.onlineAction }, ({ body, params }) =>
  onlineApplicationAction(params.id, body),
);
