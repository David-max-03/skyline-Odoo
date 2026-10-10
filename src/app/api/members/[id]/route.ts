import { CAN, memberActionSchema, memberUpdateSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { collectDues, getMember, renewMember, updateMember } from "@/server/services/members";

/** One member with membership terms, tickets and orders. */
export const GET = staffRoute(null, {}, ({ params }) => getMember(params.id));

export const PATCH = staffRoute(CAN.manageMembers, { body: memberUpdateSchema }, ({ body, params, user }) =>
  updateMember(params.id, body, user),
);

/** Renew the membership, or collect dues that are owed. */
export const POST = staffRoute(CAN.manageMembers, { body: memberActionSchema }, ({ body, params, user }) =>
  body.action === "renew"
    ? renewMember(params.id, { duesPaid: body.duesPaid, method: body.method }, user)
    : collectDues(params.id, body.method, user),
);
