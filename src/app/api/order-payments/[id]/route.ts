import { CAN, orderPaymentResolveSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { resolveOrderPayment } from "@/server/services/order-payments";

/** Record that the part of an online payment that was not owed has been refunded in Razorpay. */
export const POST = staffRoute(CAN.manageMerch, { body: orderPaymentResolveSchema }, ({ body, params, user }) =>
  resolveOrderPayment(params.id, body.note, user),
);
