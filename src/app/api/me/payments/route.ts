import { memberRoute } from "@/server/http";
import { listMemberPayments } from "@/server/services/finance";

/** The signed-in member's own payment records: dues, tickets, orders and claim repayments. */
export const GET = memberRoute({}, ({ memberId }) => listMemberPayments(memberId));
