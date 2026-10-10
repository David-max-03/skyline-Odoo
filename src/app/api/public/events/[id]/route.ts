import { publicRoute } from "@/server/http";
import { getPublicEvent } from "@/server/services/events";

export const GET = publicRoute({}, ({ params }) => getPublicEvent(params.id));
