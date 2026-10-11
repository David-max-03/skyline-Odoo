/**
 * The SQLite schema, as the ordered list of migrations that built it. SQLite
 * is used for local development and tests; production runs on PostgreSQL,
 * whose schema is in `postgres-schema.ts`. A change to one must be made to the
 * other: `tests/postgres.test.ts` compares the two.
 */

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

/**
 * Version 8: what moving to PostgreSQL needed, kept the same on both databases.
 *
 * - `orders.line_no` replaces SQLite's implicit `rowid` as the order of the
 *   lines in a checkout. Existing rows take their `rowid`, so nothing reorders.
 * - `file_contents` holds an upload's bytes in the database. Local development
 *   keeps writing files to disk by default; a serverless host has no disk to keep them on.
 * - `rate_limits` holds request counters, so a limit holds across server
 *   instances instead of per process. The key is a hash, never an address.
 */
const SCHEMA_V8 = `
ALTER TABLE orders ADD COLUMN line_no INTEGER NOT NULL DEFAULT 0;
UPDATE orders SET line_no = rowid;

CREATE TABLE file_contents (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  bytes   BLOB NOT NULL
);

CREATE TABLE rate_limits (
  bucket_key TEXT PRIMARY KEY,
  count      INTEGER NOT NULL CHECK (count > 0),
  reset_at   INTEGER NOT NULL
);
CREATE INDEX rate_limits_reset ON rate_limits(reset_at);
`;

/**
 * Version 9: volunteering. A task the committee opens to volunteers has
 * `volunteer_slots` above zero: that many members may be approved for it.
 * `volunteer_requests` is a member's request to help with a task, and, once
 * approved, their assignment to it.
 *
 *   pending    waiting for an organizer or the president
 *   approved   the member is assigned: the task is in their task list
 *   rejected   declined; the position stays open
 *   withdrawn  the member took a pending request back
 *
 * A member can have one live (pending or approved) request per task.
 */
const SCHEMA_V9 = `
ALTER TABLE tasks ADD COLUMN volunteer_slots INTEGER NOT NULL DEFAULT 0 CHECK (volunteer_slots >= 0);

CREATE TABLE volunteer_requests (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  requested_at TEXT NOT NULL,
  reviewed_at  TEXT,
  reviewed_by  TEXT REFERENCES users(id),
  review_note  TEXT
);
-- One live request or assignment per member per task.
CREATE UNIQUE INDEX volunteer_requests_live ON volunteer_requests(task_id, member_id) WHERE status IN ('pending','approved');
CREATE INDEX volunteer_requests_member ON volunteer_requests(member_id);
CREATE INDEX volunteer_requests_status ON volunteer_requests(status, requested_at);
`;

/**
 * Version 10: a committee account can be disabled. A disabled account cannot
 * sign in and has no sessions, but its row stays, so everything it recorded
 * (ledger entries, reviews, check-ins) keeps pointing at a real account.
 */
const SCHEMA_V10 = `
ALTER TABLE users ADD COLUMN disabled_at TEXT;
`;

/** Applied in order; `PRAGMA user_version` records how many have run. */
export const SQLITE_MIGRATIONS = [
  SCHEMA_V1,
  SCHEMA_V2,
  SCHEMA_V3,
  SCHEMA_V4,
  SCHEMA_V5,
  SCHEMA_V6,
  SCHEMA_V7,
  SCHEMA_V8,
  SCHEMA_V9,
  SCHEMA_V10,
];
