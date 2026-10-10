import { publicRoute } from "@/server/http";
import { readProductImage } from "@/server/services/merch";

/**
 * A product photo. Public and cacheable, unlike evidence uploads: the service
 * only returns files that are recorded as product photos.
 */
export const GET = publicRoute({}, ({ params }) => {
  const file = readProductImage(params.id);
  return new Response(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(file.bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      // A photo never changes under its id; replacing one creates a new id.
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
});
