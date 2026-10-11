import { CAN } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { listClaimants } from "@/server/services/claims";

/** President only: the committee members and volunteers a claim can be filed for. */
export const GET = staffRoute(CAN.fileClaimForOthers, {}, ({ user }) => listClaimants(user));
