import { CAN, eventInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { createEvent } from "@/server/services/events";
import { eventFor, viewEvents } from "@/server/services/staff-views";

/** Every committee role; ledger figures only for roles that may see the ledger. */
export const GET = staffRoute(null, {}, ({ user }) => viewEvents(user));

export const POST = staffRoute(CAN.manageEvents, { body: eventInputSchema }, async ({ body, user }) =>
  eventFor(await createEvent(body, user), user),
);
