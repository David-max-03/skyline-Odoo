import { checkInSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { checkIn } from "@/server/services/tickets";

/**
 * Admit a ticket holder. Always answers 200 with an `outcome`; refusals such
 * as `already_checked_in` are results the door screen displays, not errors.
 */
export const POST = staffRoute(null, { body: checkInSchema }, ({ body, user }) => checkIn(body, user));
