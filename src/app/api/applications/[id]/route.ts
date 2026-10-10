import { CAN, applicationReviewSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { reviewApplication } from "@/server/services/applications";

/**
 * Approve or reject an application. Approving requires `paymentReceived: true`
 * and returns the one-time password-setup link for the new member.
 */
export const POST = staffRoute(CAN.manageMembers, { body: applicationReviewSchema }, ({ body, params, user }) =>
  reviewApplication(params.id, body, user),
);
