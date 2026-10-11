/**
 * Creates a committee account that is not an administrator.
 *
 *   npm run staff:create -- --role treasurer --email person@example.org --name "Their Name" --env-file .env.neon
 *
 * `--role` is `treasurer` or `organizer`. It cannot create an administrator
 * (that is `admin:create`) and cannot change an existing account. It shows
 * which database it is connected to and asks you to confirm, then asks for the
 * password at a hidden prompt. The password is never taken from the command
 * line and never printed.
 */
import readline from "node:readline/promises";
import { ROLE_LABELS, type Role } from "../src/lib/contracts";
import { ADMIN_PASSWORD_MIN, STAFF_ROLES, createCommitteeAccount } from "../src/server/admin-setup";
import { all, closeDb, dbKind } from "../src/server/db";
import { describeTarget, fail, loadEnvFile, parseArgs, readSecret } from "./lib/cli";

async function main(): Promise<void> {
  const { values } = parseArgs();
  loadEnvFile(values);
  const role = values.get("role");
  const email = values.get("email")?.trim().toLowerCase();
  const name = values.get("name");
  if (!role || !email || !name) {
    throw new Error(`Usage: npm run staff:create -- --role <${STAFF_ROLES.join("|")}> --email <email> --name "<name>" [--env-file <file>]`);
  }
  if (!(STAFF_ROLES as readonly string[]).includes(role)) {
    throw new Error(`The role must be one of: ${STAFF_ROLES.join(", ")}. Use admin:create for an administrator. Nothing was created.`);
  }
  if (values.has("password")) throw new Error("Do not pass the password on the command line. You will be asked for it.");
  if (!process.stdin.isTTY) throw new Error("Run this in a terminal: it asks for confirmation and a hidden password.");

  const kind = await dbKind();
  console.log(`Database: ${kind}${kind === "postgres" ? ` at ${describeTarget(process.env.DATABASE_URL ?? "")}` : " (local file)"}`);
  const existing = await all<{ email: string; role: Role }>("SELECT email, role FROM users ORDER BY created_at");
  console.log(`Existing committee accounts: ${existing.length === 0 ? "none" : existing.map((u) => `${u.email} (${u.role})`).join(", ")}`);
  if (existing.some((u) => u.email.toLowerCase() === email)) throw new Error(`${email} already has an account. Nothing was created.`);
  console.log(`About to create: ${email}  (${name}, ${ROLE_LABELS[role as Role]})`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "create" to continue: ');
  rl.close();
  if (answer.trim() !== "create") throw new Error("Cancelled. Nothing was created.");

  const password = await readSecret(`Password for ${email} (at least ${ADMIN_PASSWORD_MIN} characters): `);
  const again = await readSecret("Type it again: ");
  if (again !== password) throw new Error("The two passwords do not match. Nothing was created.");

  const user = await createCommitteeAccount({ email, name, role, password });
  console.log(`Created ${ROLE_LABELS[user.role]} account ${user.email}. They sign in at /login.`);
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    await closeDb().catch(() => undefined);
    fail(error);
  });
