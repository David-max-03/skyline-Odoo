import { memberJoinSchema } from "@/lib/contracts";
import { LIMITS, publicRoute } from "@/server/http";
import { joinAsMember } from "@/server/services/members";

/** Sign up as a member. Dues stay unpaid until a committee member collects them. */
export const POST = publicRoute({ body: memberJoinSchema, limit: LIMITS.publicWrite }, ({ body }) =>
  joinAsMember(body),
);
