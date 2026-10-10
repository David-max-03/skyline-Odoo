import { publicRoute } from "@/server/http";
import { listPublicProducts } from "@/server/services/merch";

export const GET = publicRoute({}, () => listPublicProducts());
