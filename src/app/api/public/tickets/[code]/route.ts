import { LIMITS, publicRoute } from "@/server/http";
import { getPublicTicket } from "@/server/services/tickets";

/** The ticket a holder sees: QR code, event, status. Rate-limited against code guessing. */
export const GET = publicRoute({ limit: LIMITS.ticketLookup }, ({ params }) =>
  getPublicTicket(params.code),
);
