import { CAN, volunteerReviewSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { reviewVolunteerRequest } from "@/server/services/volunteering";

/** Approve or reject a pending request. Approval assigns the member to the task if a position is still free. */
export const POST = staffRoute(CAN.reviewVolunteers, { body: volunteerReviewSchema }, ({ body, params, user }) =>
  reviewVolunteerRequest(params.id, body, user),
);
