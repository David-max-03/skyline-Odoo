import { CAN, eventInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { updateEvent } from "@/server/services/events";
import { eventFor, viewEvent } from "@/server/services/staff-views";

/**
 * One event with its registrations. Roles that may see the ledger also get
 * the event's income and costs and the deterministic financial analysis.
 */
export const GET = staffRoute(null, {}, ({ params, user }) => viewEvent(params.id, user));

export const PATCH = staffRoute(CAN.manageEvents, { body: eventInputSchema }, async ({ body, params, user }) =>
  eventFor(await updateEvent(params.id, body, user), user),
);
