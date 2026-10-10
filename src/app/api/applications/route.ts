import { CAN } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { listApplications } from "@/server/services/applications";

/** Membership applications, those awaiting review first. */
export const GET = staffRoute(CAN.manageMembers, {}, ({ user }) => listApplications(user));
