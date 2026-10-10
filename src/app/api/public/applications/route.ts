import { applicationInputSchema } from "@/lib/contracts";
import { LIMITS, publicRoute } from "@/server/http";
import { submitApplication } from "@/server/services/applications";
import { MAX_UPLOAD_REQUEST_BYTES, readUpload } from "@/server/storage";

/**
 * Apply for membership. A multipart form: the fields of `applicationInputSchema`
 * plus the payment screenshot in `evidence`. The result is a pending
 * application; a reviewer must confirm the payment before anyone becomes a member.
 */
export const POST = publicRoute(
  { body: applicationInputSchema, form: { maxBytes: MAX_UPLOAD_REQUEST_BYTES }, limit: LIMITS.application },
  async ({ body, form, user }) => submitApplication(body, await readUpload(form, "evidence"), user),
);
