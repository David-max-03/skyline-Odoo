import { CAN, memberActionSchema, memberUpdateSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { collectDues, renewMember, updateMember } from "@/server/services/members";
import { viewMember } from "@/server/services/staff-views";

/** One member with membership terms, tickets and orders. */
export const GET = staffRoute(CAN.manageMembers, {}, ({ params, user }) => viewMember(params.id, user));

export const PATCH = staffRoute(CAN.manageMembers, { body: memberUpdateSchema }, ({ body, params, user }) =>
  updateMember(params.id, body, user),
);

/** Renew the membership, or collect dues that are owed. */
export const POST = staffRoute(CAN.manageMembers, { body: memberActionSchema }, async ({ body, params, user }) =>
  body.action === "renew"
    ? await renewMember(params.id, { duesPaid: body.duesPaid, method: body.method }, user)
    : await collectDues(params.id, body.method, user),
);
