import { claimInputSchema } from "@/lib/contracts";
import { LIMITS, publicRoute } from "@/server/http";
import { listClaims, submitClaim } from "@/server/services/claims";
import { MAX_UPLOAD_REQUEST_BYTES, readUpload } from "@/server/storage";

// Both committee accounts and members use these routes, so the wrapper only
// resolves the session; the service decides who may file and who sees what.

/** Reviewers get every claim; everyone else gets their own. */
export const GET = publicRoute({}, ({ user }) => listClaims(user));

/** File a claim. A multipart form: `claimInputSchema` fields plus the receipt photo in `evidence`. */
export const POST = publicRoute(
  { body: claimInputSchema, form: { maxBytes: MAX_UPLOAD_REQUEST_BYTES }, limit: LIMITS.publicWrite },
  async ({ body, form, user }) => submitClaim(body, await readUpload(form, "evidence"), user),
);
