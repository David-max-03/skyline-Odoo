/**
 * Reports on a PostgreSQL database without changing it: can it be reached,
 * which schema version it is at, whether the tables and the uniqueness rules
 * Skyline depends on are all there, and how many rows each table holds.
 *
 *   npm run db:status -- --env-file .env.neon
 *
 * Exits non-zero when anything is missing, so it can gate a deployment.
 */
import pg from "pg";
import { postgresSchemaVersion } from "../src/server/db/postgres";
import {
  CRITICAL_UNIQUE_COLUMNS,
  CRITICAL_UNIQUE_INDEXES,
  EXPECTED_TABLES,
  POSTGRES_SCHEMA_VERSION,
} from "../src/server/db/postgres-schema";
import { describeTarget, fail, loadEnvFile, migrationUrl, parseArgs } from "./lib/cli";

async function main(): Promise<void> {
  const { values } = parseArgs();
  loadEnvFile(values);
  const url = migrationUrl();
  console.log(`Database: ${describeTarget(url)}`);

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`Could not connect (${(error as { code?: string }).code ?? "no error code"}). Check the connection string and network access.`);
  }
  const problems: string[] = [];
  try {
    const one = async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[];
    const [{ server }] = await one<{ server: string }>("SELECT split_part(version(), ' on ', 1) AS server");
    console.log(`Connected: ${server}`);

    const version = await postgresSchemaVersion(client as unknown as pg.PoolClient);
    console.log(`Schema version: ${version} (this build needs ${POSTGRES_SCHEMA_VERSION})`);
    if (version !== POSTGRES_SCHEMA_VERSION) problems.push("schema version does not match this build; run `npm run db:migrate`");
    if (version === 0) {
      console.log("\nThe database has not been migrated yet.");
      process.exitCode = 1;
      return;
    }

    const tables = new Set((await one<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema()")).map((r) => r.t));
    for (const table of EXPECTED_TABLES) if (!tables.has(table)) problems.push(`missing table ${table}`);

    const indexes = new Set((await one<{ i: string }>("SELECT indexname AS i FROM pg_indexes WHERE schemaname = current_schema()")).map((r) => r.i));
    for (const index of CRITICAL_UNIQUE_INDEXES) if (!indexes.has(index)) problems.push(`missing unique index ${index}`);

    const uniques = await one<{ tbl: string; col: string }>(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype IN ('u','p') AND array_length(c.conkey, 1) = 1 AND c.connamespace = current_schema()::regnamespace`,
    );
    const uniqueSet = new Set(uniques.map((u) => `${u.tbl}.${u.col}`));
    for (const [table, column] of CRITICAL_UNIQUE_COLUMNS) {
      if (!uniqueSet.has(`${table}.${column}`)) problems.push(`${table}.${column} is not unique`);
    }

    const [counts] = await one<{ fk: number; chk: number; uq: number }>(
      `SELECT COUNT(*) FILTER (WHERE contype = 'f')::int AS fk, COUNT(*) FILTER (WHERE contype = 'c')::int AS chk,
              COUNT(*) FILTER (WHERE contype IN ('u','p'))::int AS uq
       FROM pg_constraint WHERE connamespace = current_schema()::regnamespace`,
    );
    console.log(`Constraints: ${counts.fk} foreign keys, ${counts.chk} checks, ${counts.uq} unique or primary keys; ${indexes.size} indexes`);
    const [{ invalid }] = await one<{ invalid: number }>("SELECT COUNT(*)::int AS invalid FROM pg_constraint WHERE NOT convalidated AND connamespace = current_schema()::regnamespace");
    if (invalid > 0) problems.push(`${invalid} constraints are not validated`);
    const [{ citext }] = await one<{ citext: number }>("SELECT COUNT(*)::int AS citext FROM pg_extension WHERE extname = 'citext'");
    if (citext !== 1) problems.push("the citext extension is not installed");

    console.log("\nRows per table:");
    for (const table of EXPECTED_TABLES) {
      if (!tables.has(table)) continue;
      const [{ n }] = await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
      console.log(`  ${table.padEnd(26)} ${n}`);
    }
    const [{ admins }] = await one<{ admins: number }>("SELECT COUNT(*)::int AS admins FROM users WHERE role = 'admin'");
    console.log(`\nAdministrator accounts: ${admins}${admins === 0 ? "  (create the first with `npm run admin:create`)" : ""}`);
  } finally {
    await client.end().catch(() => undefined);
  }

  if (problems.length > 0) {
    console.log("\nPROBLEMS:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed.");
  }
}

main().catch(fail);
