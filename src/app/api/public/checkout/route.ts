import { checkoutInputSchema } from "@/lib/contracts";
import { LIMITS, publicRoute } from "@/server/http";
import { checkout } from "@/server/services/merch";

/**
 * Check out a cart without an account. The body lists sizes and quantities
 * only; prices and the total are worked out here. Stock is reserved at once
 * and the order stays unpaid until staff record the payment.
 */
export const POST = publicRoute({ body: checkoutInputSchema, limit: LIMITS.publicWrite }, ({ body }) => checkout(body));
