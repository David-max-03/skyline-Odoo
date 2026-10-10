import { registrationInputSchema } from "@/lib/contracts";
import { LIMITS, publicRoute } from "@/server/http";
import { registerForEvent } from "@/server/services/tickets";

/**
 * A student registers for a published event. Returns only what they need to
 * open their ticket; payment, if any, stays pending until staff record it.
 */
export const POST = publicRoute(
  { body: registrationInputSchema, limit: LIMITS.publicWrite },
  ({ body, params }) => {
    const ticket = registerForEvent(params.id, body);
    return {
      code: ticket.code,
      priceCents: ticket.priceCents,
      paymentStatus: ticket.paymentStatus,
      isMember: ticket.memberId !== null,
    };
  },
);
