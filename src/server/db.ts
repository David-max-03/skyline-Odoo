import { randomBytes, randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { ymdInTz } from "@/lib/dates";

/**
 * SQLite access. One synchronous connection per process, kept on `globalThis`
 * so Next.js hot reloads reuse it. Services call `all` / `get` / `run` and wrap
 * multi-statement work in `tx`.
 */

interface DbState {
  db: DatabaseSync | null;
  file: string | null;
  statements: Map<string, StatementSync>;
  txDepth: number;
  clock: (() => Date) | null;
}

const globalState = globalThis as unknown as { __skyline?: DbState };
const state: DbState = (globalState.__skyline ??= {
  db: null,
  file: null,
  statements: new Map(),
  txDepth: 0,
  clock: null,
});

export function dbFile(): string {
  return process.env.SKYLINE_DB_PATH || path.join(process.cwd(), "data", "skyline.db");
}

export function getDb(): DatabaseSync {
  const file = dbFile();
  if (state.db && state.file === file) return state.db;
  closeDb();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;",
  );
  migrate(db);
  state.db = db;
  state.file = file;
  return db;
}

export function closeDb(): void {
  if (state.db) {
    try {
      state.db.close();
    } catch {
      // already closed
    }
  }
  state.db = null;
  state.file = null;
  state.statements.clear();
  state.txDepth = 0;
}

type Param = string | number | bigint | boolean | null | undefined;

function normalise(params: Param[]): SQLInputValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
}

function statement(sql: string): StatementSync {
  const db = getDb();
  let stmt = state.statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    state.statements.set(sql, stmt);
  }
  return stmt;
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return statement(sql).all(...normalise(params)) as T[];
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return statement(sql).get(...normalise(params)) as T | undefined;
}

export function run(sql: string, ...params: Param[]): { changes: number } {
  const result = statement(sql).run(...normalise(params));
  return { changes: Number(result.changes) };
}

/**
 * Runs `fn` in a write transaction. `BEGIN IMMEDIATE` takes the write lock up
 * front, so a read-then-write sequence (count seats, then insert a ticket)
 * cannot interleave with another writer. Nested calls join the outer
 * transaction. `fn` must be synchronous.
 */
export function tx<T>(fn: () => T): T {
  const db = getDb();
  if (state.txDepth > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  state.txDepth = 1;
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the failed statement already rolled back
    }
    throw error;
  } finally {
    state.txDepth = 0;
  }
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

// --- schema ------------------------------------------------------------------

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','treasurer','organizer')),
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE members (
  id         TEXT PRIMARY KEY,
  member_no  TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  student_id TEXT,
  phone      TEXT,
  joined_on  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE membership_periods (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('new','renewal')),
  starts_on    TEXT NOT NULL,
  ends_on      TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  paid_at      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX membership_periods_member ON membership_periods(member_id);

CREATE TABLE events (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  venue               TEXT NOT NULL,
  starts_at           TEXT NOT NULL,
  ends_at             TEXT NOT NULL,
  capacity            INTEGER NOT NULL CHECK (capacity > 0),
  price_cents         INTEGER NOT NULL CHECK (price_cents >= 0),
  member_price_cents  INTEGER NOT NULL CHECK (member_price_cents >= 0),
  profit_target_cents INTEGER CHECK (profit_target_cents IS NULL OR profit_target_cents >= 0),
  status              TEXT NOT NULL CHECK (status IN ('draft','published','cancelled')),
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE tickets (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  event_id       TEXT NOT NULL REFERENCES events(id),
  attendee_name  TEXT NOT NULL,
  attendee_email TEXT NOT NULL COLLATE NOCASE,
  student_id     TEXT,
  member_id      TEXT REFERENCES members(id),
  price_cents    INTEGER NOT NULL CHECK (price_cents >= 0),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('free','pending','paid')),
  status         TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','cancelled')),
  checked_in_at  TEXT,
  checked_in_by  TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL
);
CREATE INDEX tickets_event ON tickets(event_id);
-- One live ticket per person per event. Cancelled tickets do not count.
CREATE UNIQUE INDEX tickets_one_per_email ON tickets(event_id, attendee_email) WHERE status = 'valid';

CREATE TABLE products (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  price_cents        INTEGER NOT NULL CHECK (price_cents > 0),
  member_price_cents INTEGER NOT NULL CHECK (member_price_cents > 0),
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL
);

CREATE TABLE product_variants (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size       TEXT NOT NULL,
  -- The CHECK is the last line of defence against overselling.
  stock      INTEGER NOT NULL CHECK (stock >= 0),
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX product_variants_product ON product_variants(product_id);

CREATE TABLE orders (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  product_id       TEXT NOT NULL REFERENCES products(id),
  variant_id       TEXT NOT NULL REFERENCES product_variants(id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  total_cents      INTEGER NOT NULL CHECK (total_cents > 0),
  buyer_name       TEXT NOT NULL,
  buyer_email      TEXT NOT NULL COLLATE NOCASE,
  member_id        TEXT REFERENCES members(id),
  payment_status   TEXT NOT NULL CHECK (payment_status IN ('pending','paid')),
  status           TEXT NOT NULL DEFAULT 'placed' CHECK (status IN ('placed','fulfilled','cancelled')),
  created_at       TEXT NOT NULL
);

CREATE TABLE transactions (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('income','expense')),
  category     TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status       TEXT NOT NULL CHECK (status IN ('settled','pending')),
  occurred_on  TEXT NOT NULL,
  description  TEXT NOT NULL,
  counterparty TEXT,
  method       TEXT,
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ticket','dues','order','refund')),
  event_id     TEXT REFERENCES events(id),
  ticket_id    TEXT REFERENCES tickets(id),
  member_id    TEXT REFERENCES members(id),
  period_id    TEXT REFERENCES membership_periods(id) ON DELETE SET NULL,
  order_id     TEXT REFERENCES orders(id),
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL,
  settled_at   TEXT,
  voided_at    TEXT,
  void_reason  TEXT
);
CREATE INDEX transactions_event ON transactions(event_id);
CREATE INDEX transactions_ticket ON transactions(ticket_id);
CREATE INDEX transactions_order ON transactions(order_id);
CREATE INDEX transactions_period ON transactions(period_id);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  assignee     TEXT,
  due_on       TEXT,
  status       TEXT NOT NULL CHECK (status IN ('todo','in_progress','done')),
  event_id     TEXT REFERENCES events(id) ON DELETE SET NULL,
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE announcements (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  audience     TEXT NOT NULL CHECK (audience IN ('everyone','members')),
  created_by   TEXT REFERENCES users(id),
  published_at TEXT NOT NULL
);
`;

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version >= SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Another process may have migrated while this one waited for the lock.
    const again = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (again.user_version < SCHEMA_VERSION) {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Deletes every row. Used by the seed script and tests. */
export function wipeAllData(): void {
  tx(() => {
    for (const table of [
      "transactions",
      "orders",
      "product_variants",
      "products",
      "tickets",
      "tasks",
      "announcements",
      "events",
      "membership_periods",
      "members",
      "sessions",
      "users",
    ]) {
      run(`DELETE FROM ${table}`);
    }
  });
}
