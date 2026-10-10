import { staffRoute } from "@/server/http";
import { getDashboard } from "@/server/services/dashboard";

export const GET = staffRoute(null, {}, () => getDashboard());
