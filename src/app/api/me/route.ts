import { memberProfileSchema } from "@/lib/contracts";
import { memberRoute } from "@/server/http";
import { getMember, updateOwnProfile } from "@/server/services/members";

/** The signed-in member's own record: membership terms, tickets and orders. */
export const GET = memberRoute({}, ({ memberId }) => getMember(memberId));

/** Update the member's own phone number and student ID. Nothing else can change here. */
export const PATCH = memberRoute({ body: memberProfileSchema }, ({ body, memberId }) =>
  updateOwnProfile(memberId, body),
);
