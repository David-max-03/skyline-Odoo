import { CAN } from "@/lib/contracts";
import { listCommitteeAccounts } from "@/server/admin-setup";
import { staffRoute } from "@/server/http";

/** Committee accounts, for the president. Accounts are created from the command line, not here. */
export const GET = staffRoute(CAN.manageAccounts, {}, ({ user }) => listCommitteeAccounts(user));
