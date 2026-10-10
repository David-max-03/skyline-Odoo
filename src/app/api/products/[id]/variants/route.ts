import { CAN, variantInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { addVariant } from "@/server/services/merch";

/** Add a size to a product. */
export const POST = staffRoute(CAN.manageMerch, { body: variantInputSchema }, ({ body, params, user }) =>
  addVariant(params.id, body, user),
);
