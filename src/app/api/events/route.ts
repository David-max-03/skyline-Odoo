import { CAN, eventInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { createEvent, listEvents } from "@/server/services/events";

export const GET = staffRoute(null, {}, () => listEvents());

export const POST = staffRoute(CAN.manageEvents, { body: eventInputSchema }, ({ body, user }) =>
  createEvent(body, user),
);
