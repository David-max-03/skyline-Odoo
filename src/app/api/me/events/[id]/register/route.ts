import { LIMITS, memberRoute } from "@/server/http";
import { registerMember } from "@/server/services/tickets";

/**
 * The signed-in member registers for an event. There is no body: who they are
 * and what they pay are decided on the server. A paid event's ticket comes
 * back `pending` until the committee records the payment.
 */
export const POST = memberRoute({ limit: LIMITS.publicWrite }, async ({ params, memberId }) => {
  const ticket = await registerMember(params.id, memberId);
  return {
    code: ticket.code,
    priceCents: ticket.priceCents,
    paymentStatus: ticket.paymentStatus,
    isMember: ticket.memberId !== null,
  };
});
