import { CAN } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { viewFinanceSummary } from "@/server/services/staff-views";

export const GET = staffRoute(CAN.manageFinance, {}, ({ user }) => viewFinanceSummary(user));
