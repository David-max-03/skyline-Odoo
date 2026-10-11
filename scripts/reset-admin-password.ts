/**
 * Sets a new password for an existing administrator who has lost theirs.
 *
 *   npm run admin:reset-password -- --email you@example.org --env-file .env.neon
 *
 * It shows which database it is connected to and which account it found, and
 * asks you to confirm before asking for the new password at a hidden prompt.
 * The password is never taken from the command line and never printed. It
 * changes that one account only: it cannot create an account, and it ends the
 * account's existing sessions.
 */
import readline from "node:readline/promises";
import { ADMIN_PASSWORD_MIN, resetAdminPassword } from "../src/server/admin-setup";
import { closeDb, dbKind, get } from "../src/server/db";
import { describeTarget, fail, loadEnvFile, parseArgs, readSecret } from "./lib/cli";

async function main(): Promise<void> {
  const { values } = parseArgs();
  loadEnvFile(values);
  const email = values.get("email")?.trim().toLowerCase();
  if (!email) throw new Error("Usage: npm run admin:reset-password -- --email <email> [--env-file <file>]");
  if (values.has("password")) throw new Error("Do not pass the password on the command line. You will be asked for it.");
  if (!process.stdin.isTTY) throw new Error("Run this in a terminal: it asks for confirmation and a hidden password.");

  const kind = await dbKind();
  console.log(`Database: ${kind}${kind === "postgres" ? ` at ${describeTarget(process.env.DATABASE_URL ?? "")}` : " (local file)"}`);
  const account = await get<{ email: string; name: string; role: string; created_at: string }>(
    "SELECT email, name, role, created_at FROM users WHERE email = ?",
    email,
  );
  if (!account) throw new Error(`No account has the email ${email} in this database. Nothing was changed.`);
  console.log(`Account:  ${account.email}  (${account.name}, role ${account.role}, created ${account.created_at})`);
  if (account.role !== "admin") throw new Error("That account is not an administrator. Nothing was changed.");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "reset" to set a new password for this account: ');
  rl.close();
  if (answer.trim() !== "reset") throw new Error("Cancelled. Nothing was changed.");

  const password = await readSecret(`New password (at least ${ADMIN_PASSWORD_MIN} characters): `);
  const again = await readSecret("Type it again: ");
  if (again !== password) throw new Error("The two passwords do not match. Nothing was changed.");

  const result = await resetAdminPassword(email, password);
  console.log(`Password changed for ${result.email}. ${result.sessionsEnded} existing session(s) ended. Sign in at /login.`);
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    await closeDb().catch(() => undefined);
    fail(error);
  });
