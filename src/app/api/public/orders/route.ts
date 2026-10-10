import { orderInputSchema } from "@/lib/contracts";
import { LIMITS, publicRoute } from "@/server/http";
import { placeOrder } from "@/server/services/merch";

/** Place a merchandise order. Stock is reserved at once; payment is collected by staff. */
export const POST = publicRoute({ body: orderInputSchema, limit: LIMITS.publicWrite }, ({ body }) =>
  placeOrder(body),
);
