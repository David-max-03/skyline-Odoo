import { publicRoute } from "@/server/http";
import { getPublicProduct } from "@/server/services/merch";

/** One product that is on sale, with its sizes, stock and photos. */
export const GET = publicRoute({}, ({ params }) => getPublicProduct(params.id));
