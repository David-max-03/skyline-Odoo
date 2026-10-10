import { passwordSetupSchema } from "@/lib/contracts";
import { completeSetup } from "@/server/auth";
import { LIMITS, publicRoute } from "@/server/http";

/** Set a member's password with a one-time link. The link stops working once this succeeds. */
export const POST = publicRoute({ body: passwordSetupSchema, limit: LIMITS.passwordSetup }, ({ body }) =>
  completeSetup(body.token, body.password),
);
