import { setupTokenSchema } from "@/lib/contracts";
import { inspectStaffSetupToken } from "@/server/admin-setup";
import { LIMITS, publicRoute } from "@/server/http";

/** Whether a committee setup link is still usable, and whose account it is for. Changes nothing. */
export const POST = publicRoute({ body: setupTokenSchema, limit: LIMITS.passwordSetup }, ({ body }) =>
  inspectStaffSetupToken(body.token),
);
