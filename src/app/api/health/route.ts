import { dbKind, get } from "@/server/db";
import { failure } from "@/server/http";

/**
 * Health check: is the database reachable and at the schema version this build
 * needs? Says which kind of database is in use and nothing else. 503 when not.
 */
export async function GET(): Promise<Response> {
  try {
    const database = await dbKind();
    await get("SELECT 1 AS ok");
    return Response.json({ data: { status: "ok", database } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure("GET", "/api/health", error);
  }
}
