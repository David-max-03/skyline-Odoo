import { CAN, accountCreateSchema } from "@/lib/contracts";
import { inviteCommitteeAccount, listCommitteeAccounts } from "@/server/admin-setup";
import { staffRoute } from "@/server/http";

/** Committee accounts, for the president. */
export const GET = staffRoute(CAN.manageAccounts, {}, ({ user }) => listCommitteeAccounts(user));

/**
 * Add a committee account for a new person or an existing member. The reply
 * carries a one-time link with which that person sets their own password.
 */
export const POST = staffRoute(CAN.manageAccounts, { body: accountCreateSchema }, ({ body, user }) =>
  inviteCommitteeAccount(body, user),
);
