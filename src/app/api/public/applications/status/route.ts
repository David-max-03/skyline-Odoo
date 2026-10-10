import { applicationStatusSchema } from "@/lib/contracts";
import { LIMITS, publicRoute } from "@/server/http";
import { getApplicationStatus } from "@/server/services/applications";

/** Where an application stands. Needs both the application code and the email it was made with. */
export const POST = publicRoute({ body: applicationStatusSchema, limit: LIMITS.ticketLookup }, ({ body }) =>
  getApplicationStatus(body.code, body.email),
);
