import { CAN } from "@/lib/contracts";
import { issueCommitteeSetupLink } from "@/server/admin-setup";
import { staffRoute } from "@/server/http";

/** Issue a new one-time password link for a committee account. Cancels any earlier unused link. */
export const POST = staffRoute(CAN.manageAccounts, {}, ({ params, user }) => issueCommitteeSetupLink(params.id, user));
