import { CAN, transactionInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { createTransaction } from "@/server/services/finance";
import { viewTransactions } from "@/server/services/staff-views";

/** Ledger entries. Filters: type, status, category, eventId ("none" = not tied to an event), voided=1. */
export const GET = staffRoute(CAN.manageFinance, {}, ({ query, user }) =>
  viewTransactions(
    {
      type: query.get("type"),
      status: query.get("status"),
      category: query.get("category"),
      eventId: query.get("eventId"),
      includeVoided: query.get("voided") === "1",
    },
    user,
  ),
);

export const POST = staffRoute(CAN.manageFinance, { body: transactionInputSchema }, ({ body, user }) =>
  createTransaction(body, user),
);
