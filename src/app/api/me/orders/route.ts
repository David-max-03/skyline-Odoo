import { memberRoute } from "@/server/http";
import { listMemberOrders } from "@/server/services/merch";

/** The signed-in member's own order history. */
export const GET = memberRoute({}, ({ memberId }) => listMemberOrders(memberId));
