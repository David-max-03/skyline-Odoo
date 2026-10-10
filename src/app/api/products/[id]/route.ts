import { CAN, productUpdateSchema, stockUpdateSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { setStock, updateProduct } from "@/server/services/merch";

export const PATCH = staffRoute(CAN.manageMerch, { body: productUpdateSchema }, ({ body, params, user }) =>
  updateProduct(params.id, body, user),
);

/** Set the counted stock for one size. */
export const POST = staffRoute(CAN.manageMerch, { body: stockUpdateSchema }, ({ body, params, user }) =>
  setStock(params.id, body.variantId, body.stock, user),
);
