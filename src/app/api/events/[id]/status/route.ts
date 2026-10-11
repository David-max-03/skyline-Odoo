import { CAN, eventStatusSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { setEventStatus } from "@/server/services/events";
import { eventFor } from "@/server/services/staff-views";

/** Publish, unpublish or cancel an event. */
export const POST = staffRoute(CAN.manageEvents, { body: eventStatusSchema }, async ({ body, params, user }) => {
  const change = await setEventStatus(params.id, body.status, user);
  return { ...change, event: eventFor(change.event, user) };
});
