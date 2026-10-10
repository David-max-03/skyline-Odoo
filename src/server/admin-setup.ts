import type { SessionUser } from "@/lib/contracts";
import { createUser } from "./auth";
import { get, tx } from "./db";
import { AppError, conflict } from "./errors";

/** The first administrator signs everyone else up, so this password gets a higher bar than the general one. */
export const ADMIN_PASSWORD_MIN = 12;

/**
 * Creates the committee's first administrator account. This is the only way
 * an account comes into existence on a new database: there is no default
 * account and nothing is created when the server starts.
 *
 * It refuses when an administrator already exists, so running the command
 * again cannot quietly add another one; `allowAdditional` is the deliberate
 * override. The check and the insert share one transaction.
 */
export async function createFirstAdmin(
  input: { email: string; name: string; password: string },
  options: { allowAdditional?: boolean } = {},
): Promise<SessionUser> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError("invalid", "Enter a valid email address.", 422);
  if (name.length < 2) throw new AppError("invalid", "Enter the administrator's name.", 422);
  if (input.password.length < ADMIN_PASSWORD_MIN) {
    throw new AppError("weak_password", `The password must be at least ${ADMIN_PASSWORD_MIN} characters.`, 422);
  }
  return tx(async () => {
    const existing = await get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
    if ((existing?.n ?? 0) > 0 && !options.allowAdditional) {
      throw conflict("admin_exists", "An administrator account already exists. Nothing was created.");
    }
    return createUser({ email, name, role: "admin", password: input.password });
  });
}
