import { verifySchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { verifyTicket } from "@/server/services/tickets";

/** Look a ticket up without changing it. */
export const POST = staffRoute(null, { body: verifySchema }, ({ body, user }) =>
  verifyTicket(body.code, body.eventId, user),
);
