import { cookies } from "next/headers";
import { SESSION_COOKIE, logout } from "@/server/auth";
import { publicRoute } from "@/server/http";

export const POST = publicRoute({}, async ({ req }) => {
  await logout(req.cookies.get(SESSION_COOKIE)?.value);
  (await cookies()).delete(SESSION_COOKIE);
  return { ok: true };
});
