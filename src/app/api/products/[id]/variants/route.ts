import { CAN, stockLevelsSchema, variantInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { addVariant, setStockLevels } from "@/server/services/merch";

/** Add a size to a product. */
export const POST = staffRoute(CAN.manageMerch, { body: variantInputSchema }, ({ body, params, user }) =>
  addVariant(params.id, body, user),
);

/**
 * Set the counted stock of existing sizes. Only the sizes listed change, and
 * they are saved together or not at all.
 */
export const PATCH = staffRoute(CAN.manageMerch, { body: stockLevelsSchema }, ({ body, params, user }) =>
  setStockLevels(params.id, body.levels, user),
);
