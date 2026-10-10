import { CAN } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { listOrderPayments } from "@/server/services/order-payments";

/** Online merchandise payments, those that need a refund first. */
export const GET = staffRoute(CAN.manageMerch, {}, ({ user }) => listOrderPayments(user));
