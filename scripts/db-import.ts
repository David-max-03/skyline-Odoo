/**
 * Copies a Skyline SQLite database into PostgreSQL. For a deliberate, one-off
 * move of real data; it is never run by a deployment and it is not how a new
 * production database should start (that is `db:migrate` then `admin:create`).
 *
 *   npm run db:import -- --source data/backups/<backup>.db --env-file .env.neon
 *   npm run db:import -- --source data/backups/<backup>.db --env-file .env.neon --apply
 *
 * Without `--apply` it is a dry run: it reads the source, checks the
 * destination and reports, and writes nothing.
 *
 * Safeguards:
 * - The source must be a backup file, not the live local database.
 * - The destination must be migrated to this build's schema and must be empty.
 * - Everything is written in one transaction, with every id, relationship,
 *   amount and timestamp unchanged. Afterwards row counts, ledger totals and
 *   paid-order/settlement consistency are compared with the source; any
 *   difference rolls the whole import back.
 * - Sessions, password links and rate-limit counters are not copied.
 * - It does not look at whether rows are test data. Do not import a database
 *   of test members, demo accounts or Razorpay test payments into production.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { sqliteFile } from "../src/server/db/config";
import { postgresSchemaVersion } from "../src/server/db/postgres";
import { POSTGRES_SCHEMA_VERSION } from "../src/server/db/postgres-schema";
import { describeTarget, fail, loadEnvFile, migrationUrl, parseArgs } from "./lib/cli";

/** Tables in an order that satisfies every foreign key. */
const COPY_ORDER = [
  "users", "members", "membership_periods", "member_accounts", "events", "tickets", "products",
  "product_variants", "checkouts", "orders", "transactions", "tasks", "announcements", "files",
  "membership_applications", "expense_claims", "product_images", "online_applications",
  "razorpay_webhook_events", "order_payments", "order_payment_lines",
] as const;
const NOT_COPIED = ["sessions", "member_sessions", "account_setup_tokens", "rate_limits"];

const LEDGER_SQL = "SELECT type, status, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total FROM transactions GROUP BY type, status ORDER BY type, status";
const CONSISTENCY_SQL = `SELECT
  (SELECT COUNT(*) FROM orders WHERE payment_status = 'paid') AS paid_orders,
  (SELECT COUNT(*) FROM transactions WHERE source = 'order' AND type = 'income' AND status = 'settled' AND voided_at IS NULL) AS settled_order_entries,
  (SELECT COUNT(*) FROM membership_periods WHERE paid_at IS NOT NULL) AS paid_terms,
  (SELECT COUNT(*) FROM order_payments WHERE razorpay_payment_id IS NOT NULL) AS recorded_order_payments,
  (SELECT COUNT(*) FROM online_applications WHERE razorpay_payment_id IS NOT NULL) AS recorded_membership_payments`;

const canonical = (rows: Record<string, unknown>[]) =>
  JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" || typeof v === "string" ? Number(v) || v : v]))));

async function main(): Promise<void> {
  const { flags, values } = parseArgs();
  loadEnvFile(values);
  const apply = flags.has("apply");
  const sourcePath = values.get("source");
  if (!sourcePath) throw new Error("Give the source backup with --source <file>. Nothing was done.");
  const source = path.resolve(sourcePath);
  if (!fs.existsSync(source)) throw new Error(`Source not found: ${source}`);
  if (source === path.resolve(sqliteFile())) {
    throw new Error("The source is the live local database. Make a backup copy and import that instead.");
  }
  const uploads = path.resolve(values.get("uploads") ?? path.join(path.dirname(sqliteFile()), "uploads"));

  const sqlite = new DatabaseSync(source, { readOnly: true });
  const url = migrationUrl();
  console.log(`Source:      ${source}`);
  console.log(`Destination: ${describeTarget(url)}`);
  console.log(apply ? "Mode:        APPLY" : "Mode:        dry run (add --apply to write)");

  const integrity = (sqlite.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  const fkProblems = sqlite.prepare("PRAGMA foreign_key_check").all().length;
  if (integrity !== "ok" || fkProblems > 0) throw new Error(`The source failed its own checks (integrity: ${integrity}, foreign-key problems: ${fkProblems}).`);

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await client.connect().catch((error) => {
    throw new Error(`Could not connect to the destination (${(error as { code?: string }).code ?? "no error code"}).`);
  });
  try {
    const version = await postgresSchemaVersion(client as unknown as pg.PoolClient);
    if (version !== POSTGRES_SCHEMA_VERSION) throw new Error(`The destination is at schema version ${version}; this build needs ${POSTGRES_SCHEMA_VERSION}. Run db:migrate first.`);
    for (const table of [...COPY_ORDER, "file_contents"]) {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      if (rows[0].n > 0) throw new Error(`The destination is not empty (${table} has ${rows[0].n} rows). Import only into a new database.`);
    }

    const sourceCounts = new Map<string, number>();
    console.log("\nRows to copy:");
    for (const table of COPY_ORDER) {
      const n = (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      sourceCounts.set(table, n);
      console.log(`  ${table.padEnd(26)} ${n}`);
    }
    console.log(`  (not copied: ${NOT_COPIED.join(", ")})`);

    const files = sqlite.prepare("SELECT id, size FROM files").all() as { id: string; size: number }[];
    const missing = files.filter((f) => !fs.existsSync(path.join(uploads, f.id)));
    console.log(`\nUploads: ${files.length} recorded, ${files.length - missing.length} found in ${uploads}`);
    if (missing.length > 0) throw new Error(`${missing.length} recorded uploads have no file in the uploads folder. Give the right folder with --uploads.`);

    const ledgerBefore = sqlite.prepare(LEDGER_SQL).all() as Record<string, unknown>[];
    const consistencyBefore = sqlite.prepare(CONSISTENCY_SQL).all() as Record<string, unknown>[];
    console.log("\nLedger in the source (type, status, entries, total in minor units):");
    for (const r of ledgerBefore) console.log(`  ${String(r.type).padEnd(8)} ${String(r.status).padEnd(8)} ${String(r.n).padStart(6)} ${String(r.total).padStart(14)}`);

    if (!apply) {
      console.log("\nDry run complete. Nothing was written.");
      return;
    }

    await client.query("BEGIN");
    try {
      for (const table of COPY_ORDER) {
        const columns = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
        const insert = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`;
        for (const row of sqlite.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]) {
          await client.query(insert, columns.map((c) => row[c]));
        }
      }
      for (const file of files) {
        const bytes = fs.readFileSync(path.join(uploads, file.id));
        if (bytes.length !== file.size) throw new Error(`Upload ${file.id} is ${bytes.length} bytes on disk but recorded as ${file.size}.`);
        await client.query("INSERT INTO file_contents (file_id, bytes) VALUES ($1, $2)", [file.id, bytes]);
      }

      for (const table of COPY_ORDER) {
        const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
        if (rows[0].n !== sourceCounts.get(table)) throw new Error(`Row count differs for ${table}: source ${sourceCounts.get(table)}, destination ${rows[0].n}.`);
      }
      const ledgerAfter = (await client.query(LEDGER_SQL)).rows;
      if (canonical(ledgerAfter) !== canonical(ledgerBefore)) throw new Error("Ledger totals differ between source and destination.");
      const consistencyAfter = (await client.query(CONSISTENCY_SQL)).rows;
      if (canonical(consistencyAfter) !== canonical(consistencyBefore)) throw new Error("Payment and settlement counts differ between source and destination.");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`Import failed and was rolled back; the destination is unchanged. ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log("\nImported. Row counts, ledger totals and payment consistency match the source.");
    console.log("Members will need new password links only if their accounts were not in the source; sessions were not copied.");
  } finally {
    await client.end().catch(() => undefined);
    sqlite.close();
  }
}

main().catch(fail);
