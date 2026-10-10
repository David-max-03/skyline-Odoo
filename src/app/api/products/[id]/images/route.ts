import { CAN } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { addProductImage } from "@/server/services/merch";
import { MAX_UPLOAD_REQUEST_BYTES, readUpload } from "@/server/storage";

/** Add a photo to a product. A multipart form with the photo in `image`. */
export const POST = staffRoute(CAN.manageMerch, { form: { maxBytes: MAX_UPLOAD_REQUEST_BYTES } }, async ({ form, params, user }) =>
  addProductImage(params.id, await readUpload(form, "image"), user),
);
