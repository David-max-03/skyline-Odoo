import { publicRoute } from "@/server/http";
import { readEvidence } from "@/server/services/applications";

/**
 * An uploaded evidence image. `readEvidence` decides who may see it; this
 * route only sets headers that stop the browser caching it or treating it as
 * anything other than the image type recorded when it was stored.
 */
export const GET = publicRoute({}, async ({ params, user }) => {
  const file = await readEvidence(params.id, user);
  return new Response(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(file.bytes.length),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
});
