import { CAN, onlineReconcileSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { reconcileOnlinePayment } from "@/server/services/online-applications";

/**
 * Sort out an online application: `check` it against Razorpay, `activate` a
 * paid one whose member could not be created, or record it as `refunded`.
 */
export const POST = staffRoute(CAN.manageMembers, { body: onlineReconcileSchema }, ({ body, params, user }) =>
  reconcileOnlinePayment(params.id, body, user),
);
