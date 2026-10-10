import { setupTokenSchema } from "@/lib/contracts";
import { inspectSetupToken } from "@/server/auth";
import { LIMITS, publicRoute } from "@/server/http";

/** Whether a setup link is still usable, and whose account it is for. Changes nothing. */
export const POST = publicRoute({ body: setupTokenSchema, limit: LIMITS.passwordSetup }, ({ body }) =>
  inspectSetupToken(body.token),
);
