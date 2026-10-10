import { staffRoute } from "@/server/http";
import { listOrders } from "@/server/services/merch";

export const GET = staffRoute(null, {}, () => listOrders());
