import { CAN, memberInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { createMember } from "@/server/services/members";
import { viewMembers } from "@/server/services/staff-views";

// The member list is personal data: the president and the treasurer only.
export const GET = staffRoute(CAN.manageMembers, {}, ({ user }) => viewMembers(user));

export const POST = staffRoute(CAN.manageMembers, { body: memberInputSchema }, ({ body, user }) =>
  createMember(body, user),
);
