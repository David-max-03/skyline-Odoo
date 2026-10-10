/**
 * Applies Skyline's PostgreSQL migrations. Migrations never run on a request;
 * this command is the only thing that changes the schema.
 *
 *   npm run db:migrate -- --env-file .env.neon            apply
 *   npm run db:migrate -- --env-file .env.neon --dry-run  show what would run
 *
 * Use the direct (unpooled) connection string, in DATABASE_URL_UNPOOLED. It is
 * safe to run again: it does nothing when the schema is up to date.
 */
import { migratePostgres } from "../src/server/db/postgres";
import { POSTGRES_SCHEMA_VERSION } from "../src/server/db/postgres-schema";
import { describeTarget, fail, loadEnvFile, migrationUrl, parseArgs } from "./lib/cli";

async function main(): Promise<void> {
  const { flags, values } = parseArgs();
  loadEnvFile(values);
  const url = migrationUrl();
  const dryRun = flags.has("dry-run");
  console.log(`Database: ${describeTarget(url)}`);
  const report = await migratePostgres(url, { dryRun });
  console.log(`Schema version before: ${report.before}   this build needs: ${POSTGRES_SCHEMA_VERSION}`);
  if (report.applied.length === 0) {
    console.log("Nothing to do: the schema is up to date.");
    return;
  }
  for (const m of report.applied) console.log(`  ${dryRun ? "would apply" : "applied"}  ${m.version}  ${m.name}`);
  console.log(dryRun ? "Dry run: nothing was changed." : `Schema version now: ${report.after}`);
}

main().catch(fail);
