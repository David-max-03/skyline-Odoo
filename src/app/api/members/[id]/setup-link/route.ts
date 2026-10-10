import { CAN } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { issueSetupLink } from "@/server/services/members";

/** Issue a one-time password-setup link for a member. Revokes any earlier unused link. */
export const POST = staffRoute(CAN.manageMembers, {}, ({ params, user }) => issueSetupLink(params.id, user));
