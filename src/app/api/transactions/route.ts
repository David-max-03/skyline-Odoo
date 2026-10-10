import { transactionInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { createTransaction, listTransactions } from "@/server/services/finance";

/** Ledger entries. Filters: type, status, category, eventId ("none" = not tied to an event), voided=1. */
export const GET = staffRoute(null, {}, ({ query }) =>
  listTransactions({
    type: query.get("type"),
    status: query.get("status"),
    category: query.get("category"),
    eventId: query.get("eventId"),
    includeVoided: query.get("voided") === "1",
  }),
);

// Any staff member may call this; the service limits organizers to pending expense claims.
export const POST = staffRoute(null, { body: transactionInputSchema }, ({ body, user }) =>
  createTransaction(body, user),
);
