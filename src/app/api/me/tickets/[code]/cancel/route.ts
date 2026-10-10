import { memberRoute } from "@/server/http";
import { cancelOwnTicket } from "@/server/services/tickets";

/** The signed-in member cancels their own unpaid, unused ticket. */
export const POST = memberRoute({}, async ({ params, memberId }) => {
  const ticket = await cancelOwnTicket(params.code, memberId);
  return { code: ticket.code, status: ticket.status };
});
