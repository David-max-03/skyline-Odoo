import { CAN, accountActionSchema } from "@/lib/contracts";
import { setCommitteeAccountStatus } from "@/server/admin-setup";
import { staffRoute } from "@/server/http";

/** Disable a committee account (ending its sessions), or enable it again. */
export const POST = staffRoute(CAN.manageAccounts, { body: accountActionSchema }, ({ body, params, user }) =>
  setCommitteeAccountStatus(params.id, body.action, user),
);
