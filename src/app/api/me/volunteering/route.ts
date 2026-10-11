import { volunteerRequestSchema } from "@/lib/contracts";
import { LIMITS, memberRoute } from "@/server/http";
import { memberVolunteering, requestToVolunteer } from "@/server/services/volunteering";

/** Tasks open to volunteers, and the signed-in member's own requests. */
export const GET = memberRoute({}, ({ memberId }) => memberVolunteering(memberId));

/** Ask to volunteer for a task. Creates a pending request; an organizer or the president decides. */
export const POST = memberRoute({ body: volunteerRequestSchema, limit: LIMITS.publicWrite }, ({ body, memberId }) =>
  requestToVolunteer(memberId, body.taskId),
);
