import { CAN } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { removeProductImage } from "@/server/services/merch";

/** Remove a photo from a product. */
export const DELETE = staffRoute(CAN.manageMerch, {}, ({ params, user }) =>
  removeProductImage(params.id, params.imageId, user),
);
