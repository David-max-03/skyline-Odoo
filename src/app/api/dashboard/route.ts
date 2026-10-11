import { staffRoute } from "@/server/http";
import { viewDashboard } from "@/server/services/staff-views";

/** Every committee role; member counts and money only for roles that may see them. */
export const GET = staffRoute(null, {}, ({ user }) => viewDashboard(user));
