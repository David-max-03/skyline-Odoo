import { CAN } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { listOnlinePayments } from "@/server/services/online-applications";

/** Online membership payments, those that need a reviewer first. */
export const GET = staffRoute(CAN.manageMembers, {}, ({ user }) => listOnlinePayments(user));
