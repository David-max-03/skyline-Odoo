import { CAN, eventInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { breakEvenFor, profitTargetForEvent } from "@/server/services/analysis";
import { getEvent, updateEvent } from "@/server/services/events";
import { listEventTickets } from "@/server/services/tickets";

/** One event with its registrations and the deterministic financial analysis. */
export const GET = staffRoute(null, {}, ({ params }) => {
  const event = getEvent(params.id);
  return {
    event,
    tickets: listEventTickets(event.id),
    breakEven: breakEvenFor(event),
    profitTarget: event.profitTargetCents === null ? null : profitTargetForEvent(event),
  };
});

export const PATCH = staffRoute(CAN.manageEvents, { body: eventInputSchema }, ({ body, params, user }) =>
  updateEvent(params.id, body, user),
);
