import { CAN, orderPaymentResolveSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { resolveOrderPayment } from "@/server/services/order-payments";

/** President only. Record that the part of an online payment that was not owed has been refunded in Razorpay. */
export const POST = staffRoute(CAN.processRefunds, { body: orderPaymentResolveSchema }, ({ body, params, user }) =>
  resolveOrderPayment(params.id, body.note, user),
);
