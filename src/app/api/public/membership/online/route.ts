import { onlineApplicationInputSchema } from "@/lib/contracts";
import { LIMITS, publicRoute } from "@/server/http";
import { startOnlineApplication } from "@/server/services/online-applications";

/**
 * Start an online membership application: stores the applicant's details and
 * creates the Razorpay order for the membership fee. The reply carries what
 * Checkout needs and an access token for this browser. Nobody is a member yet.
 */
export const POST = publicRoute({ body: onlineApplicationInputSchema, limit: LIMITS.onlineStart }, ({ body }) =>
  startOnlineApplication(body),
);
