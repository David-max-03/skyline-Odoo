import { CAN, orderActionSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { actOnOrder } from "@/server/services/merch";

/** Record payment for, hand over, or cancel a merchandise order. */
export const POST = staffRoute(CAN.manageMerch, { body: orderActionSchema }, ({ body, params, user }) =>
  actOnOrder(params.id, body.action, body.method, user),
);
