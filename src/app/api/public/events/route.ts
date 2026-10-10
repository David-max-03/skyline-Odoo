import { publicRoute } from "@/server/http";
import { listPublicEvents } from "@/server/services/events";

/** Published events that have not ended. No registrant data. */
export const GET = publicRoute({}, () => listPublicEvents());
