import { memberCheckoutSchema } from "@/lib/contracts";
import { LIMITS, memberRoute } from "@/server/http";
import { checkoutAsMember } from "@/server/services/merch";

/** The signed-in member checks out. Who they are and what they pay come from the server. */
export const POST = memberRoute({ body: memberCheckoutSchema, limit: LIMITS.publicWrite }, ({ body, memberId }) =>
  checkoutAsMember(body.items, memberId),
);
