/**
 * Creates the first committee administrator on a new database.
 *
 *   npm run admin:create -- --email you@example.org --name "Your Name" --env-file .env.neon
 *
 * The password is typed at a hidden prompt (or piped on standard input); it is
 * never taken from the command line and never printed. The command refuses to
 * run when an administrator already exists, unless `--allow-additional` is given.
 */
import { ADMIN_PASSWORD_MIN, createFirstAdmin } from "../src/server/admin-setup";
import { closeDb, dbKind } from "../src/server/db";
import { describeTarget, fail, loadEnvFile, parseArgs, readSecret } from "./lib/cli";

async function main(): Promise<void> {
  const { flags, values } = parseArgs();
  loadEnvFile(values);
  const email = values.get("email");
  const name = values.get("name");
  if (!email || !name) throw new Error('Usage: npm run admin:create -- --email <email> --name "<name>" [--env-file <file>]');
  if (values.has("password")) throw new Error("Do not pass the password on the command line. You will be asked for it.");

  const kind = await dbKind();
  console.log(`Database: ${kind}${kind === "postgres" ? ` at ${describeTarget(process.env.DATABASE_URL ?? "")}` : " (local file)"}`);

  const password = await readSecret(`Password for ${email} (at least ${ADMIN_PASSWORD_MIN} characters): `);
  if (process.stdin.isTTY) {
    const again = await readSecret("Type it again: ");
    if (again !== password) throw new Error("The two passwords do not match. Nothing was created.");
  }
  const user = await createFirstAdmin({ email, name, password }, { allowAdditional: flags.has("allow-additional") });
  console.log(`Created administrator ${user.email}. Sign in at /login with the password you just set.`);
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    await closeDb().catch(() => undefined);
    fail(error);
  });
