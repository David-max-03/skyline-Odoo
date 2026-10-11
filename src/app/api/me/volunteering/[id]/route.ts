import { volunteerWithdrawSchema } from "@/lib/contracts";
import { memberRoute } from "@/server/http";
import { withdrawVolunteerRequest } from "@/server/services/volunteering";

/** Withdraw one of the signed-in member's own pending requests. The only thing a member can do to a request. */
export const POST = memberRoute({ body: volunteerWithdrawSchema }, ({ params, memberId }) =>
  withdrawVolunteerRequest(memberId, params.id),
);
