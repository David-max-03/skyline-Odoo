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

const SCHEMA_V1 = `
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

/**
 * Version 2: member accounts and membership applications. Everything here is
 * a new table, so an existing database is upgraded in place and no existing
 * row changes.
 */
const SCHEMA_V2 = `
-- A member's password. Members without a row here have not set one up yet.
CREATE TABLE member_accounts (
  member_id       TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  password_hash   TEXT NOT NULL,
  password_set_at TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

-- Kept apart from staff sessions so a member session can never resolve to a staff role.
CREATE TABLE member_sessions (
  token_hash TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One-time links for setting a password. Only the SHA-256 of the token is stored.
CREATE TABLE account_setup_tokens (
  token_hash TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX account_setup_tokens_member ON account_setup_tokens(member_id);

-- Uploaded evidence. The bytes live on disk under the uploads folder, named by id.
CREATE TABLE files (
  id         TEXT PRIMARY KEY,
  purpose    TEXT NOT NULL CHECK (purpose IN ('application_payment','claim_receipt','product_image')),
  mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  size       INTEGER NOT NULL CHECK (size > 0),
  sha256     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE membership_applications (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL COLLATE NOCASE,
  student_id        TEXT,
  phone             TEXT,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents >= 0),
  payment_method    TEXT NOT NULL CHECK (payment_method IN ('upi','bank','cash')),
  payment_reference TEXT NOT NULL,
  evidence_file_id  TEXT REFERENCES files(id),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  review_note       TEXT,
  reviewed_by       TEXT REFERENCES users(id),
  reviewed_at       TEXT,
  member_id         TEXT REFERENCES members(id),
  created_at        TEXT NOT NULL
);
-- One open application per person.
CREATE UNIQUE INDEX membership_applications_open_email
  ON membership_applications(email) WHERE status = 'pending';
-- A bank or UPI reference pays for one membership only.
CREATE UNIQUE INDEX membership_applications_reference
  ON membership_applications(payment_method, payment_reference)
  WHERE status <> 'rejected' AND payment_method <> 'cash';
`;

/**
 * Version 3: a task can be assigned to a member, so the member can see and
 * progress it. `assignee` stays as the display name; tasks given to someone
 * without a member record keep a name and a NULL id.
 */
const SCHEMA_V3 = `
ALTER TABLE tasks ADD COLUMN assignee_member_id TEXT REFERENCES members(id) ON DELETE SET NULL;
CREATE INDEX tasks_assignee_member ON tasks(assignee_member_id);
`;

/**
 * Version 4: expense claims. A claim is a request, not money: it reaches the
 * ledger only when a reviewer approves it, as one pending expense row that
 * `transaction_id` points at. Paying that row marks the claim paid.
 */
const SCHEMA_V4 = `
CREATE TABLE expense_claims (
  id                 TEXT PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,
  claimant_member_id TEXT REFERENCES members(id),
  claimant_user_id   TEXT REFERENCES users(id),
  claimant_name      TEXT NOT NULL,
  title              TEXT NOT NULL,
  justification      TEXT NOT NULL,
  notes              TEXT,
  category           TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
  spent_on           TEXT NOT NULL,
  event_id           TEXT REFERENCES events(id),
  -- A claim cannot exist without its photo.
  evidence_file_id   TEXT NOT NULL REFERENCES files(id),
  status             TEXT NOT NULL DEFAULT 'submitted'
                     CHECK (status IN ('submitted','under_review','approved','rejected','paid')),
  review_note        TEXT,
  reviewed_by        TEXT REFERENCES users(id),
  reviewed_at        TEXT,
  transaction_id     TEXT UNIQUE REFERENCES transactions(id),
  created_at         TEXT NOT NULL,
  -- Exactly one kind of claimant.
  CHECK ((claimant_member_id IS NULL) <> (claimant_user_id IS NULL))
);
CREATE INDEX expense_claims_member ON expense_claims(claimant_member_id);
CREATE INDEX expense_claims_user ON expense_claims(claimant_user_id);
`;

/**
 * Version 5: the shop. A checkout groups the lines bought together. Each
 * line is still one `orders` row with its own ledger entry, so payment,
 * hand-over and cancellation keep working per line exactly as before. A line
 * now also keeps the product name and size it was sold as, so later edits to
 * a product do not rewrite past orders.
 */
const SCHEMA_V5 = `
ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'apparel';

CREATE TABLE product_images (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL UNIQUE REFERENCES files(id),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX product_images_product ON product_images(product_id);

CREATE TABLE checkouts (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  buyer_name  TEXT NOT NULL,
  buyer_email TEXT NOT NULL COLLATE NOCASE,
  member_id   TEXT REFERENCES members(id),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  created_at  TEXT NOT NULL
);

ALTER TABLE orders ADD COLUMN checkout_id TEXT REFERENCES checkouts(id);
ALTER TABLE orders ADD COLUMN product_name TEXT;
ALTER TABLE orders ADD COLUMN size_label TEXT;
CREATE INDEX orders_checkout ON orders(checkout_id);
`;

/**
 * Version 6: paying the membership fee online through Razorpay. Everything
 * here is additive: one new column with a default, and two new tables.
 *
 * An online application lives in `online_applications` until its payment is
 * verified. Only then does it get a row in `membership_applications` (already
 * approved, `channel = 'razorpay'`), a member and a ledger entry. The states:
 *
 *   pending       order created, no successful payment yet
 *   failed        the last attempt failed; the same order can be paid again
 *   superseded    the person started again; a late payment here still counts
 *   activated     payment verified and the member created
 *   needs_review  payment verified, but a member could not be created
 *   refunded      a reviewer returned a needs_review payment in Razorpay
 */
const SCHEMA_V6 = `
ALTER TABLE membership_applications
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'manual' CHECK (channel IN ('manual','razorpay'));

CREATE TABLE online_applications (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  email               TEXT NOT NULL COLLATE NOCASE,
  student_id          TEXT,
  phone               TEXT,
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  currency            TEXT NOT NULL,
  -- SHA-256 of the secret held by the applicant's browser.
  access_token_hash   TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','failed','superseded','activated','needs_review','refunded')),
  -- One Razorpay order per application; retries pay the same order.
  razorpay_order_id   TEXT NOT NULL UNIQUE,
  -- A payment is recorded once, and pays for one application only.
  razorpay_payment_id TEXT UNIQUE,
  payment_method      TEXT,
  paid_at             TEXT,
  verified_via        TEXT CHECK (verified_via IN ('checkout','webhook','lookup')),
  failure_reason      TEXT,
  failed_at           TEXT,
  review_reason       TEXT,
  resolved_by         TEXT REFERENCES users(id),
  resolved_at         TEXT,
  resolution_note     TEXT,
  -- One application row and one member per payment.
  application_id      TEXT UNIQUE REFERENCES membership_applications(id),
  member_id           TEXT UNIQUE REFERENCES members(id),
  -- When a password-setup link was first handed out for this application.
  setup_link_issued_at TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK ((razorpay_payment_id IS NULL) = (paid_at IS NULL)),
  -- The paid states are exactly the ones with a recorded payment.
  CHECK ((status IN ('activated','needs_review','refunded')) = (razorpay_payment_id IS NOT NULL)),
  CHECK ((status = 'activated') = (member_id IS NOT NULL))
);
-- One open online application per person.
CREATE UNIQUE INDEX online_applications_open_email
  ON online_applications(email) WHERE status IN ('pending','failed');
CREATE INDEX online_applications_status ON online_applications(status, created_at);

-- Every webhook delivery that passed signature verification, keyed by
-- Razorpay's event id so a repeat delivery is recognised and skipped.
CREATE TABLE razorpay_webhook_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  order_id    TEXT,
  payment_id  TEXT,
  outcome     TEXT NOT NULL,
  received_at TEXT NOT NULL
);
`;

/**
 * Version 7: paying for merchandise online. Two new tables; nothing existing
 * changes. An order line is still paid by settling its pending ledger entry,
 * whether staff record cash or Razorpay confirms a payment. These tables only
 * record the online attempt: which lines it was for, and what became of it.
 *
 *   pending       a Razorpay order exists and is unpaid
 *   failed        the last attempt failed; the same Razorpay order can be paid again
 *   superseded    replaced because the amount owed changed; a late payment still counts
 *   paid          verified, and every line it covered was settled by it
 *   needs_review  verified, but part of it paid for a line that was already paid or cancelled
 *   refunded      a reviewer returned the part that was not owed
 */
const SCHEMA_V7 = `
CREATE TABLE order_payments (
  id                  TEXT PRIMARY KEY,
  member_id           TEXT NOT NULL REFERENCES members(id),
  -- The checkout code (CHK-…), or the order code for an order placed before checkouts existed.
  order_code          TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','failed','superseded','paid','needs_review','refunded')),
  razorpay_order_id   TEXT NOT NULL UNIQUE,
  -- A payment is recorded once, for one attempt only.
  razorpay_payment_id TEXT UNIQUE,
  payment_method      TEXT,
  paid_at             TEXT,
  verified_via        TEXT CHECK (verified_via IN ('checkout','webhook','lookup')),
  -- How much of the payment settled order lines. The rest is owed back.
  applied_cents       INTEGER CHECK (applied_cents IS NULL OR applied_cents >= 0),
  failure_reason      TEXT,
  failed_at           TEXT,
  review_reason       TEXT,
  resolved_by         TEXT REFERENCES users(id),
  resolved_at         TEXT,
  resolution_note     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK ((razorpay_payment_id IS NULL) = (paid_at IS NULL)),
  CHECK ((status IN ('paid','needs_review','refunded')) = (razorpay_payment_id IS NOT NULL))
);
-- One open attempt per order, so two clicks cannot start two payments.
CREATE UNIQUE INDEX order_payments_open ON order_payments(order_code) WHERE status IN ('pending','failed');
CREATE INDEX order_payments_member ON order_payments(member_id);

-- The lines an attempt was created to pay, with the amount of each at that moment.
CREATE TABLE order_payment_lines (
  payment_id   TEXT NOT NULL REFERENCES order_payments(id) ON DELETE CASCADE,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (payment_id, order_id)
);
`;

/** Applied in order; `PRAGMA user_version` records how many have run. */
const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7];

function migrate(db: DatabaseSync): void {
  const version = () => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version() >= MIGRATIONS.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Read again inside the lock: another process may have migrated meanwhile.
    for (let applied = version(); applied < MIGRATIONS.length; applied++) {
      db.exec(MIGRATIONS[applied]);
      db.exec(`PRAGMA user_version = ${applied + 1}`);
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
      "order_payment_lines",
      "order_payments",
      "razorpay_webhook_events",
      "online_applications",
      "expense_claims",
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
      "files",
      "account_setup_tokens",
      "member_sessions",
      "member_accounts",
      "membership_periods",
      "members",
      "sessions",
      "users",
    ]) {
      run(`DELETE FROM ${table}`);
    }
  });
}
