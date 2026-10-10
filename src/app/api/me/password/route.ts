import { passwordChangeSchema } from "@/lib/contracts";
import { SESSION_COOKIE, changeMemberPassword } from "@/server/auth";
import { LIMITS, memberRoute } from "@/server/http";

/** Change the signed-in member's password. Needs the current one; other devices are signed out. */
export const POST = memberRoute({ body: passwordChangeSchema, limit: LIMITS.passwordSetup }, async ({ body, memberId, req }) => {
  await changeMemberPassword(memberId, body.currentPassword, body.newPassword, req.cookies.get(SESSION_COOKIE)?.value);
  return { ok: true };
});
