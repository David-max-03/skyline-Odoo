import { ticketActionSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { cancelTicket, payTicket, undoCheckIn } from "@/server/services/tickets";

/** Record payment for, cancel, or undo the check-in of one ticket. */
export const POST = staffRoute(null, { body: ticketActionSchema }, async ({ body, params, user }) => {
  if (body.action === "pay") return { ticket: await payTicket(params.code, body.method, user), refundDueCents: 0 };
  if (body.action === "cancel") return cancelTicket(params.code, user);
  return { ticket: await undoCheckIn(params.code, user), refundDueCents: 0 };
});
