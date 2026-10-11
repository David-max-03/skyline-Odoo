import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomInt } from "node:crypto";
import { ymdInTz } from "@/lib/dates";
import { configKey, resolveDbConfig, sqliteFile } from "./db/config";
import { DatabaseUnavailableError, type Driver, type DriverKind, type Executor, type SqlValue } from "./db/types";

/**
 * Database access. Services call `all` / `get` / `run` and wrap multi-statement
 * work in `tx`. Everything is asynchronous.
 *
 * Production runs on PostgreSQL; SQLite is for local development and tests
 * (`db/config.ts` decides which, and never falls back from one to the other).
 * SQL is written once, with `?` placeholders, in the subset both databases
 * share. The connection is opened on first use, never while a module loads.
 */

interface DbState {
  driver: Promise<Driver> | null;
  key: string | null;
  clock: (() => Date) | null;
  /** The transaction the current async call chain is inside, if any. */
  scope: AsyncLocalStorage<Executor>;
}

// Kept on `globalThis` so Next.js hot reloads and separately bundled routes share one connection.
const globalState = globalThis as unknown as { __skylineDb?: DbState };
const state: DbState = (globalState.__skylineDb ??= {
  driver: null,
  key: null,
  clock: null,
  scope: new AsyncLocalStorage<Executor>(),
});

async function open(): Promise<Driver> {
  const config = resolveDbConfig();
  if (config.kind === "postgres") {
    const { openPostgres } = await import("./db/postgres");
    return openPostgres(config.url);
  }
  const { openSqlite } = await import("./db/sqlite");
  return openSqlite(config.file);
}

function driver(): Promise<Driver> {
  const key = configKey(resolveDbConfig());
  if (state.driver && state.key === key) return state.driver;
  const previous = state.driver;
  state.key = key;
  const opening = (async () => {
    if (previous) await previous.then((d) => d.close()).catch(() => undefined);
    return open();
  })();
  state.driver = opening;
  // A failed attempt is not remembered, so the next request tries again.
  opening.catch(() => {
    if (state.driver === opening) {
      state.driver = null;
      state.key = null;
    }
  });
  return opening;
}

/** Which database this process is using. Opens the connection if it is not open yet. */
export async function dbKind(): Promise<DriverKind> {
  return (await driver()).kind;
}

/** Where the SQLite file lives, for local development. Not meaningful on PostgreSQL. */
export function dbFile(): string {
  return sqliteFile();
}

export async function closeDb(): Promise<void> {
  const current = state.driver;
  state.driver = null;
  state.key = null;
  if (current) await current.then((d) => d.close()).catch(() => undefined);
}

export type Param = string | number | bigint | boolean | null | undefined | Uint8Array;

/** Flags are stored as 0/1 integers on both databases; `undefined` is stored as NULL. */
function normalise(params: Param[]): SqlValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
}

async function executor(): Promise<Executor> {
  return state.scope.getStore() ?? (await driver());
}

export async function all<T>(sql: string, ...params: Param[]): Promise<T[]> {
  return (await (await executor()).query(sql, normalise(params), true)).rows as T[];
}

export async function get<T>(sql: string, ...params: Param[]): Promise<T | undefined> {
  return (await (await executor()).query(sql, normalise(params), true)).rows[0] as T | undefined;
}

export async function run(sql: string, ...params: Param[]): Promise<{ changes: number }> {
  return { changes: (await (await executor()).query(sql, normalise(params), false)).rowCount };
}

/**
 * Runs `fn` in a write transaction: everything in it commits together, or
 * nothing does if it throws. Statements issued anywhere inside `fn`, however
 * deeply nested, use the transaction's own connection. A nested `tx` joins the
 * outer one.
 *
 * Write transactions never run at the same time as each other. A
 * read-then-write sequence inside one (count the seats, then insert a ticket;
 * read the highest member number, then insert the next) therefore cannot
 * interleave with another writer. SQLite does this with `BEGIN IMMEDIATE`;
 * the PostgreSQL driver takes one advisory lock per transaction.
 *
 * Never call a payment provider, or anything else slow, inside `fn`: the
 * lock is held until it returns.
 */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (state.scope.getStore()) return fn();
  return (await driver()).transaction((inside) => state.scope.run(inside, fn));
}

// --- clock (overridable in tests) ------------------------------------------

export function now(): Date {
  return state.clock ? state.clock() : new Date();
}
export function nowIso(): string {
  return now().toISOString();
}
/** Today's calendar date in the organisation's timezone. */
export function today(): string {
  return ymdInTz(now());
}
export function setClock(clock: (() => Date) | null): void {
  state.clock = clock;
}

// --- identifiers -------------------------------------------------------------

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

// No 0/O, 1/I/L or U, so codes survive being read aloud or typed by hand.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function randomCode(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

// --- maintenance ---------------------------------------------------------------

/** Every table, children before the tables they reference. */
export const TABLES_IN_DELETE_ORDER = [
  "rate_limits",
  "order_payment_lines",
  "order_payments",
  "razorpay_webhook_events",
  "online_applications",
  "expense_claims",
  "volunteer_requests",
  "transactions",
  "orders",
  "checkouts",
  "product_images",
  "product_variants",
  "products",
  "tickets",
  "tasks",
  "announcements",
  "events",
  "membership_applications",
  "file_contents",
  "files",
  "account_setup_tokens",
  "member_sessions",
  "member_accounts",
  "membership_periods",
  "members",
  "sessions",
  "users",
] as const;

/** Deletes every row. Used by the seed script and tests. Never called by a request. */
export async function wipeAllData(): Promise<void> {
  await tx(async () => {
    for (const table of TABLES_IN_DELETE_ORDER) {
      await run(`DELETE FROM ${table}`);
    }
  });
}

export { DatabaseUnavailableError };
