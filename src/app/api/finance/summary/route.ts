import { staffRoute } from "@/server/http";
import { getFinanceSummary } from "@/server/services/finance";

export const GET = staffRoute(null, {}, () => getFinanceSummary());
