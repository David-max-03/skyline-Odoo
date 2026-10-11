import { CAN } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { viewOrders } from "@/server/services/staff-views";

export const GET = staffRoute(CAN.manageMerch, {}, ({ user }) => viewOrders(user));
