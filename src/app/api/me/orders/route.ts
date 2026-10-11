import { shopperRoute } from "@/server/http";
import { listMemberOrders } from "@/server/services/merch";

/** The signed-in member's own order history; for a linked committee account, that member's. */
export const GET = shopperRoute({}, ({ memberId }) => listMemberOrders(memberId));
