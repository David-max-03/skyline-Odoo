import { staffPasswordSetupSchema } from "@/lib/contracts";
import { completeStaffSetup } from "@/server/admin-setup";
import { LIMITS, publicRoute } from "@/server/http";

/** Set a committee account's password with a one-time link. The link stops working once this succeeds. */
export const POST = publicRoute({ body: staffPasswordSetupSchema, limit: LIMITS.passwordSetup }, ({ body }) =>
  completeStaffSetup(body.token, body.password),
);
