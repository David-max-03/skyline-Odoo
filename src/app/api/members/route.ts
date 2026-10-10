import { CAN, memberInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { createMember, listMembers } from "@/server/services/members";

// The member list is personal data: signed-in staff only.
export const GET = staffRoute(null, {}, () => listMembers());

export const POST = staffRoute(CAN.manageMembers, { body: memberInputSchema }, ({ body, user }) =>
  createMember(body, user),
);
