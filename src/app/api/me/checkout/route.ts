import { memberCheckoutSchema } from "@/lib/contracts";
import { LIMITS, shopperRoute } from "@/server/http";
import { checkoutAsMember } from "@/server/services/merch";

/**
 * The signed-in member checks out, or a committee account linked to a member
 * record checks out as that member. Who they are and what they pay come from the server.
 */
export const POST = shopperRoute({ body: memberCheckoutSchema, limit: LIMITS.publicWrite }, ({ body, memberId }) =>
  checkoutAsMember(body.items, memberId),
);
