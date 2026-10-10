import { CAN, eventStatusSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { setEventStatus } from "@/server/services/events";

/** Publish, unpublish or cancel an event. */
export const POST = staffRoute(CAN.manageEvents, { body: eventStatusSchema }, ({ body, params, user }) =>
  setEventStatus(params.id, body.status, user),
);
