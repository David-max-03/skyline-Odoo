import { cookies } from "next/headers";
import { loginSchema } from "@/lib/contracts";
import { SESSION_COOKIE, signIn } from "@/server/auth";
import { LIMITS, publicRoute } from "@/server/http";
import { seedIfEmptyInDevelopment } from "@/server/seed";

export const POST = publicRoute({ body: loginSchema, limit: LIMITS.login }, async ({ body, req }) => {
  await seedIfEmptyInDevelopment();
  const session = await signIn(body.email, body.password);
  const https =
    req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  (await cookies()).set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: https,
    path: "/",
    expires: session.expiresAt,
  });
  return { user: session.user };
});
