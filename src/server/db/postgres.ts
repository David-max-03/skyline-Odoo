import type { Pool, PoolClient } from "pg";
import { isServerless } from "./config";
import { MIGRATIONS_TABLE, POSTGRES_MIGRATIONS, POSTGRES_SCHEMA_VERSION } from "./postgres-schema";
import { DatabaseUnavailableError, type Driver, type Executor, type QueryResult, type SqlValue } from "./types";

/**
 * PostgreSQL driver (node-postgres). Used in production, against a pooled
 * connection string such as Neon's `-pooler` endpoint.
 *
 * Connections come from a small pool created on first use. A serverless
 * instance keeps at most a few, so many instances cannot exhaust the database.
 *
 * Concurrency. SQLite allowed one writer at a time, and the services rely on
 * that: "read the highest member number, insert the next", "check the stock,
 * take it", "check nothing is recorded, record the payment". To keep exactly
 * that guarantee, every write transaction begins by taking the same
 * transaction-level advisory lock, on its own connection. Two write
 * transactions therefore never overlap, on any instance. The lock is released
 * by COMMIT or ROLLBACK, which is why it also works through a transaction
 * pooler. All multi-statement writes in Skyline go through `tx`, so all of
 * them follow this protocol; single statements outside `tx` are atomic on
 * their own. Unique constraints and conditional updates remain underneath as
 * a second line of defence.
 */

/** "SKYL" as an integer: the one advisory lock every write transaction takes. */
const WRITE_LOCK_KEY = 0x534b594c;

// PostgreSQL type OIDs whose default JavaScript form differs from SQLite's.
const OID_BOOL = 16;
const OID_INT8 = 20;
const OID_NUMERIC = 1700;

/** Rewrites `?` placeholders as `$1, $2, …`, leaving quoted text alone. */
const translated = new Map<string, string>();
export function toPostgresSql(sql: string): string {
  const cached = translated.get(sql);
  if (cached !== undefined) return cached;
  let out = "";
  let index = 0;
  let quote: string | null = null;
  for (const char of sql) {
    if (quote) {
      if (char === quote) quote = null;
      out += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      out += char;
    } else if (char === "?") {
      out += `$${++index}`;
    } else {
      out += char;
    }
  }
  translated.set(sql, out);
  return out;
}

// Connection-level failures: the database is not there, not reachable or not accepting us.
const UNAVAILABLE_SQLSTATE = /^(08|53|57P0|28|3D000|55P03)/;
const UNAVAILABLE_NODE = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"]);

/**
 * Turns "cannot reach or use the database" into `DatabaseUnavailableError`,
 * with a reason that is safe to log. Anything else (a constraint violation, a
 * bug in a query) is passed through unchanged.
 */
function classify(error: unknown): unknown {
  if (error instanceof DatabaseUnavailableError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  if (typeof code === "string" && (UNAVAILABLE_SQLSTATE.test(code) || UNAVAILABLE_NODE.has(code))) {
    return new DatabaseUnavailableError(code === "55P03" ? "busy (lock timeout)" : `connection failed (${code})`);
  }
  if (/timeout exceeded when trying to connect|Connection terminated/i.test(message)) {
    return new DatabaseUnavailableError("connection timed out");
  }
  return error;
}

async function createPool(url: string): Promise<Pool> {
  const pg = (await import("pg")).default;
  // COUNT and SUM come back as 64-bit integers and booleans as true/false.
  // Skyline's numbers are far below 2^53 and its flags are 0/1, as in SQLite.
  const types = {
    getTypeParser(oid: number, format?: "text" | "binary") {
      if (oid === OID_INT8 || oid === OID_NUMERIC) return (value: string) => Number(value);
      if (oid === OID_BOOL) return (value: string) => (value === "t" ? 1 : 0);
      return pg.types.getTypeParser(oid, format as "text");
    },
  };
  const max = Number(process.env.SKYLINE_PG_POOL_MAX) || (isServerless() ? 3 : 10);
  const pool = new pg.Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    types: types as never,
  });
  // An idle connection dropped by the server must not crash the process. No connection details are logged.
  pool.on("error", (error) => {
    console.error(`[db] idle PostgreSQL connection closed (${(error as { code?: string }).code ?? "unknown"})`);
  });
  return pool;
}

const toResult = (result: { rows: unknown[]; rowCount: number | null }, wantRows: boolean): QueryResult =>
  wantRows
    ? { rows: result.rows as Record<string, unknown>[], rowCount: result.rows.length }
    : { rows: [], rowCount: result.rowCount ?? 0 };

/** The schema version recorded in the database, or 0 when it has never been migrated. */
export async function postgresSchemaVersion(db: Pool | PoolClient): Promise<number> {
  const exists = await db.query("SELECT to_regclass('schema_migrations') AS t");
  if (!exists.rows[0]?.t) return 0;
  const row = await db.query("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations");
  return Number(row.rows[0].v);
}

export async function openPostgres(url: string): Promise<Driver> {
  const pool = await createPool(url);
  try {
    const version = await postgresSchemaVersion(pool);
    if (version !== POSTGRES_SCHEMA_VERSION) {
      throw new DatabaseUnavailableError(
        `schema is at version ${version} but this build needs ${POSTGRES_SCHEMA_VERSION}; run the migration command`,
      );
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw classify(error);
  }

  const on = (db: Pool | PoolClient): Executor => ({
    async query(sql: string, params: SqlValue[], wantRows: boolean) {
      try {
        return toResult(await db.query(toPostgresSql(sql), params), wantRows);
      } catch (error) {
        throw classify(error);
      }
    },
  });

  return {
    kind: "postgres",
    query: on(pool).query,
    async transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        throw classify(error);
      }
      let broken = false;
      try {
        await client.query("BEGIN");
        // Give up instead of queueing for ever if another writer is stuck.
        await client.query("SET LOCAL lock_timeout = '15s'");
        await client.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK_KEY]);
        const result = await fn(on(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The connection is gone; it must not go back into the pool.
          broken = true;
        }
        throw classify(error);
      } finally {
        client.release(broken);
      }
    },
    close: async () => {
      await pool.end().catch(() => undefined);
    },
  };
}

// --- migrations ------------------------------------------------------------------

export interface MigrationReport {
  before: number;
  after: number;
  applied: { version: number; name: string }[];
}

/**
 * Applies every migration that has not run yet, each in its own transaction
 * together with its `schema_migrations` row, so a failed migration leaves
 * nothing behind. Safe to run again: it does nothing when up to date. Use a
 * direct (not pooled) connection string. Called by `npm run db:migrate` and by
 * tests, never by a request.
 */
export async function migratePostgres(url: string, options: { dryRun?: boolean } = {}): Promise<MigrationReport> {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
  } catch (error) {
    throw classify(error);
  }
  try {
    // One migrator at a time, for the whole run.
    await client.query("SELECT pg_advisory_lock($1)", [WRITE_LOCK_KEY + 1]);
    const before = await postgresSchemaVersion(client as unknown as PoolClient);
    const pending = POSTGRES_MIGRATIONS.filter((m) => m.version > before);
    const applied: MigrationReport["applied"] = [];
    if (!options.dryRun) {
      await client.query(MIGRATIONS_TABLE);
      for (const migration of pending) {
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)", [
            migration.version,
            migration.name,
            new Date().toISOString(),
          ]);
          await client.query("COMMIT");
          applied.push({ version: migration.version, name: migration.name });
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw new Error(
            `Migration ${migration.version} (${migration.name}) failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    return {
      before,
      after: options.dryRun ? before : before + applied.length,
      applied: options.dryRun ? pending.map(({ version, name }) => ({ version, name })) : applied,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}
