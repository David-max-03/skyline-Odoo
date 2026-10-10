import { CAN, claimReviewSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { reviewClaim } from "@/server/services/claims";

/** Start reviewing, approve, reject or pay a claim. Treasurer and president only, and never their own. */
export const POST = staffRoute(CAN.manageFinance, { body: claimReviewSchema }, ({ body, params, user }) =>
  reviewClaim(params.id, body, user),
);
