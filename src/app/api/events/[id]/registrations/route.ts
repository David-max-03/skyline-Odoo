import { staffRegistrationSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { registerForEvent } from "@/server/services/tickets";

/** Staff register someone at the desk, optionally recording payment at once. */
export const POST = staffRoute(null, { body: staffRegistrationSchema }, ({ body, params, user }) => {
  const { payNow, ...registration } = body;
  return registerForEvent(params.id, registration, { actor: user, payNow });
});
