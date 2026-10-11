import { CAN, accountActionSchema, accountRoleSchema } from "@/lib/contracts";
import { setCommitteeAccountRole, setCommitteeAccountStatus } from "@/server/admin-setup";
import { staffRoute } from "@/server/http";

/** Disable a committee account (ending its sessions), or enable it again. */
export const POST = staffRoute(CAN.manageAccounts, { body: accountActionSchema }, ({ body, params, user }) =>
  setCommitteeAccountStatus(params.id, body.action, user),
);

/** Change a committee account's role. Its sessions are ended so the new role applies at once. */
export const PATCH = staffRoute(CAN.manageAccounts, { body: accountRoleSchema }, ({ body, params, user }) =>
  setCommitteeAccountRole(params.id, body.role, user),
);
