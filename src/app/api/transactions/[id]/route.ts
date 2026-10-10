import { CAN, transactionActionSchema, transactionInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { settleTransaction, updateTransaction, voidTransaction } from "@/server/services/finance";

export const PATCH = staffRoute(
  CAN.manageFinance,
  { body: transactionInputSchema },
  ({ body, params, user }) => updateTransaction(params.id, body, user),
);

/** Settle a pending entry, or void one entered by mistake. */
export const POST = staffRoute(
  CAN.manageFinance,
  { body: transactionActionSchema },
  async ({ body, params, user }) =>
    body.action === "settle"
      ? await settleTransaction(params.id, body.method, user)
      : await voidTransaction(params.id, body.reason, user),
);
