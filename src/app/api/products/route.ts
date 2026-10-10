import { CAN, productInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { createProduct, listProducts } from "@/server/services/merch";

export const GET = staffRoute(null, {}, () => listProducts());

export const POST = staffRoute(CAN.manageMerch, { body: productInputSchema }, ({ body, user }) =>
  createProduct(body, user),
);
