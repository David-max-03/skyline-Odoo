/**
 * The PostgreSQL schema, as versioned migrations. They are applied by an
 * explicit command (`npm run db:migrate`), never by a request, and
 * `schema_migrations` records which have run.
 *
 * Version 1 is the whole schema as it stood when Skyline moved from SQLite
 * (SQLite's migrations 1 to 8). It keeps the same tables, columns, keys,
 * checks and partial indexes, with these deliberate choices:
 *
 * - Identifiers stay the application's own text ids (`mem_…`, `ord_…`).
 * - Money stays INTEGER minor units. Nothing is stored as a decimal or float.
 * - Timestamps stay ISO-8601 UTC text and dates stay `YYYY-MM-DD` text, as the
 *   code writes and compares them. No timezone conversion can creep in.
 * - Text is `COLLATE "C"`, so ordering and comparison are byte-wise exactly as
 *   in SQLite, whatever locale the database was created with.
 * - Emails are `citext`, which gives the case-insensitive uniqueness and
 *   lookup that SQLite's `COLLATE NOCASE` gave.
 * - Flags stay 0/1 integers.
 *
 * A later change is a new entry in `POSTGRES_MIGRATIONS`; existing entries are
 * never edited once they have run anywhere.
 */

const T = `TEXT COLLATE "C"`;

const V1_BASELINE = `
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id            ${T} PRIMARY KEY,
  email         CITEXT NOT NULL UNIQUE,
  name          ${T} NOT NULL,
  role          ${T} NOT NULL CHECK (role IN ('admin','treasurer','organizer')),
  password_hash ${T} NOT NULL,
  created_at    ${T} NOT NULL
);

CREATE TABLE sessions (
  token_hash ${T} PRIMARY KEY,
  user_id    ${T} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at ${T} NOT NULL,
  created_at ${T} NOT NULL
);

CREATE TABLE members (
  id         ${T} PRIMARY KEY,
  member_no  ${T} NOT NULL UNIQUE,
  name       ${T} NOT NULL,
  email      CITEXT NOT NULL UNIQUE,
  student_id ${T},
  phone      ${T},
  joined_on  ${T} NOT NULL,
  created_at ${T} NOT NULL
);

CREATE TABLE membership_periods (
  id           ${T} PRIMARY KEY,
  member_id    ${T} NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind         ${T} NOT NULL CHECK (kind IN ('new','renewal')),
  starts_on    ${T} NOT NULL,
  ends_on      ${T} NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  paid_at      ${T},
  created_at   ${T} NOT NULL
);
CREATE INDEX membership_periods_member ON membership_periods(member_id);

CREATE TABLE events (
  id                  ${T} PRIMARY KEY,
  title               ${T} NOT NULL,
  description         ${T} NOT NULL DEFAULT '',
  venue               ${T} NOT NULL,
  starts_at           ${T} NOT NULL,
  ends_at             ${T} NOT NULL,
  capacity            INTEGER NOT NULL CHECK (capacity > 0),
  price_cents         INTEGER NOT NULL CHECK (price_cents >= 0),
  member_price_cents  INTEGER NOT NULL CHECK (member_price_cents >= 0),
  profit_target_cents INTEGER CHECK (profit_target_cents IS NULL OR profit_target_cents >= 0),
  status              ${T} NOT NULL CHECK (status IN ('draft','published','cancelled')),
  created_by          ${T} REFERENCES users(id),
  created_at          ${T} NOT NULL,
  updated_at          ${T} NOT NULL
);

CREATE TABLE tickets (
  id             ${T} PRIMARY KEY,
  code           ${T} NOT NULL UNIQUE,
  event_id       ${T} NOT NULL REFERENCES events(id),
  attendee_name  ${T} NOT NULL,
  attendee_email CITEXT NOT NULL,
  student_id     ${T},
  member_id      ${T} REFERENCES members(id),
  price_cents    INTEGER NOT NULL CHECK (price_cents >= 0),
  payment_status ${T} NOT NULL CHECK (payment_status IN ('free','pending','paid')),
  status         ${T} NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','cancelled')),
  checked_in_at  ${T},
  checked_in_by  ${T} REFERENCES users(id),
  created_at     ${T} NOT NULL
);
CREATE INDEX tickets_event ON tickets(event_id);
-- One live ticket per person per event. Cancelled tickets do not count.
CREATE UNIQUE INDEX tickets_one_per_email ON tickets(event_id, attendee_email) WHERE status = 'valid';

CREATE TABLE products (
  id                 ${T} PRIMARY KEY,
  name               ${T} NOT NULL,
  description        ${T} NOT NULL DEFAULT '',
  price_cents        INTEGER NOT NULL CHECK (price_cents > 0),
  member_price_cents INTEGER NOT NULL CHECK (member_price_cents > 0),
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         ${T} NOT NULL,
  category           ${T} NOT NULL DEFAULT 'apparel'
);

CREATE TABLE product_variants (
  id         ${T} PRIMARY KEY,
  product_id ${T} NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size       ${T} NOT NULL,
  -- The CHECK is the last line of defence against overselling.
  stock      INTEGER NOT NULL CHECK (stock >= 0),
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX product_variants_product ON product_variants(product_id);

CREATE TABLE checkouts (
  id          ${T} PRIMARY KEY,
  code        ${T} NOT NULL UNIQUE,
  buyer_name  ${T} NOT NULL,
  buyer_email CITEXT NOT NULL,
  member_id   ${T} REFERENCES members(id),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  created_at  ${T} NOT NULL
);

CREATE TABLE orders (
  id               ${T} PRIMARY KEY,
  code             ${T} NOT NULL UNIQUE,
  product_id       ${T} NOT NULL REFERENCES products(id),
  variant_id       ${T} NOT NULL REFERENCES product_variants(id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  total_cents      INTEGER NOT NULL CHECK (total_cents > 0),
  buyer_name       ${T} NOT NULL,
  buyer_email      CITEXT NOT NULL,
  member_id        ${T} REFERENCES members(id),
  payment_status   ${T} NOT NULL CHECK (payment_status IN ('pending','paid')),
  status           ${T} NOT NULL DEFAULT 'placed' CHECK (status IN ('placed','fulfilled','cancelled')),
  created_at       ${T} NOT NULL,
  checkout_id      ${T} REFERENCES checkouts(id),
  product_name     ${T},
  size_label       ${T},
  -- The order of the lines within a checkout.
  line_no          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX orders_checkout ON orders(checkout_id);

CREATE TABLE transactions (
  id           ${T} PRIMARY KEY,
  type         ${T} NOT NULL CHECK (type IN ('income','expense')),
  category     ${T} NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status       ${T} NOT NULL CHECK (status IN ('settled','pending')),
  occurred_on  ${T} NOT NULL,
  description  ${T} NOT NULL,
  counterparty ${T},
  method       ${T},
  source       ${T} NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ticket','dues','order','refund')),
  event_id     ${T} REFERENCES events(id),
  ticket_id    ${T} REFERENCES tickets(id),
  member_id    ${T} REFERENCES members(id),
  period_id    ${T} REFERENCES membership_periods(id) ON DELETE SET NULL,
  order_id     ${T} REFERENCES orders(id),
  created_by   ${T} REFERENCES users(id),
  created_at   ${T} NOT NULL,
  settled_at   ${T},
  voided_at    ${T},
  void_reason  ${T}
);
CREATE INDEX transactions_event ON transactions(event_id);
CREATE INDEX transactions_ticket ON transactions(ticket_id);
CREATE INDEX transactions_order ON transactions(order_id);
CREATE INDEX transactions_period ON transactions(period_id);

CREATE TABLE tasks (
  id                 ${T} PRIMARY KEY,
  title              ${T} NOT NULL,
  description        ${T} NOT NULL DEFAULT '',
  assignee           ${T},
  due_on             ${T},
  status             ${T} NOT NULL CHECK (status IN ('todo','in_progress','done')),
  event_id           ${T} REFERENCES events(id) ON DELETE SET NULL,
  created_by         ${T} REFERENCES users(id),
  created_at         ${T} NOT NULL,
  completed_at       ${T},
  assignee_member_id ${T} REFERENCES members(id) ON DELETE SET NULL
);
CREATE INDEX tasks_assignee_member ON tasks(assignee_member_id);

CREATE TABLE announcements (
  id           ${T} PRIMARY KEY,
  title        ${T} NOT NULL,
  body         ${T} NOT NULL,
  audience     ${T} NOT NULL CHECK (audience IN ('everyone','members')),
  created_by   ${T} REFERENCES users(id),
  published_at ${T} NOT NULL
);

-- A member's password. Members without a row here have not set one up yet.
CREATE TABLE member_accounts (
  member_id       ${T} PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  password_hash   ${T} NOT NULL,
  password_set_at ${T} NOT NULL,
  created_at      ${T} NOT NULL
);

-- Kept apart from staff sessions so a member session can never resolve to a staff role.
CREATE TABLE member_sessions (
  token_hash ${T} PRIMARY KEY,
  member_id  ${T} NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at ${T} NOT NULL,
  created_at ${T} NOT NULL
);

-- One-time links for setting a password. Only the SHA-256 of the token is stored.
CREATE TABLE account_setup_tokens (
  token_hash ${T} PRIMARY KEY,
  member_id  ${T} NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at ${T} NOT NULL,
  used_at    ${T},
  created_by ${T} REFERENCES users(id),
  created_at ${T} NOT NULL
);
CREATE INDEX account_setup_tokens_member ON account_setup_tokens(member_id);

-- Uploaded evidence and product photos: what each file is.
CREATE TABLE files (
  id         ${T} PRIMARY KEY,
  purpose    ${T} NOT NULL CHECK (purpose IN ('application_payment','claim_receipt','product_image')),
  mime       ${T} NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  size       INTEGER NOT NULL CHECK (size > 0),
  sha256     ${T} NOT NULL,
  created_at ${T} NOT NULL
);

-- The bytes of each upload. Kept in the database because a serverless host has no disk to keep them on.
CREATE TABLE file_contents (
  file_id ${T} PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  bytes   BYTEA NOT NULL
);

CREATE TABLE membership_applications (
  id                ${T} PRIMARY KEY,
  code              ${T} NOT NULL UNIQUE,
  name              ${T} NOT NULL,
  email             CITEXT NOT NULL,
  student_id        ${T},
  phone             ${T},
  amount_cents      INTEGER NOT NULL CHECK (amount_cents >= 0),
  payment_method    ${T} NOT NULL CHECK (payment_method IN ('upi','bank','cash')),
  payment_reference ${T} NOT NULL,
  evidence_file_id  ${T} REFERENCES files(id),
  status            ${T} NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  review_note       ${T},
  reviewed_by       ${T} REFERENCES users(id),
  reviewed_at       ${T},
  member_id         ${T} REFERENCES members(id),
  created_at        ${T} NOT NULL,
  channel           ${T} NOT NULL DEFAULT 'manual' CHECK (channel IN ('manual','razorpay'))
);
-- One open application per person.
CREATE UNIQUE INDEX membership_applications_open_email
  ON membership_applications(email) WHERE status = 'pending';
-- A bank or UPI reference pays for one membership only.
CREATE UNIQUE INDEX membership_applications_reference
  ON membership_applications(payment_method, payment_reference)
  WHERE status <> 'rejected' AND payment_method <> 'cash';

CREATE TABLE expense_claims (
  id                 ${T} PRIMARY KEY,
  code               ${T} NOT NULL UNIQUE,
  claimant_member_id ${T} REFERENCES members(id),
  claimant_user_id   ${T} REFERENCES users(id),
  claimant_name      ${T} NOT NULL,
  title              ${T} NOT NULL,
  justification      ${T} NOT NULL,
  notes              ${T},
  category           ${T} NOT NULL,
  amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
  spent_on           ${T} NOT NULL,
  event_id           ${T} REFERENCES events(id),
  -- A claim cannot exist without its photo.
  evidence_file_id   ${T} NOT NULL REFERENCES files(id),
  status             ${T} NOT NULL DEFAULT 'submitted'
                     CHECK (status IN ('submitted','under_review','approved','rejected','paid')),
  review_note        ${T},
  reviewed_by        ${T} REFERENCES users(id),
  reviewed_at        ${T},
  transaction_id     ${T} UNIQUE REFERENCES transactions(id),
  created_at         ${T} NOT NULL,
  -- Exactly one kind of claimant.
  CHECK ((claimant_member_id IS NULL) <> (claimant_user_id IS NULL))
);
CREATE INDEX expense_claims_member ON expense_claims(claimant_member_id);
CREATE INDEX expense_claims_user ON expense_claims(claimant_user_id);

CREATE TABLE product_images (
  id         ${T} PRIMARY KEY,
  product_id ${T} NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_id    ${T} NOT NULL UNIQUE REFERENCES files(id),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at ${T} NOT NULL
);
CREATE INDEX product_images_product ON product_images(product_id);

-- Membership fees paid online. See the SQLite schema's version 6 for the states.
CREATE TABLE online_applications (
  id                   ${T} PRIMARY KEY,
  code                 ${T} NOT NULL UNIQUE,
  name                 ${T} NOT NULL,
  email                CITEXT NOT NULL,
  student_id           ${T},
  phone                ${T},
  amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
  currency             ${T} NOT NULL,
  access_token_hash    ${T} NOT NULL UNIQUE,
  status               ${T} NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','failed','superseded','activated','needs_review','refunded')),
  razorpay_order_id    ${T} NOT NULL UNIQUE,
  -- A payment is recorded once, and pays for one application only.
  razorpay_payment_id  ${T} UNIQUE,
  payment_method       ${T},
  paid_at              ${T},
  verified_via         ${T} CHECK (verified_via IN ('checkout','webhook','lookup')),
  failure_reason       ${T},
  failed_at            ${T},
  review_reason        ${T},
  resolved_by          ${T} REFERENCES users(id),
  resolved_at          ${T},
  resolution_note      ${T},
  -- One application row and one member per payment.
  application_id       ${T} UNIQUE REFERENCES membership_applications(id),
  member_id            ${T} UNIQUE REFERENCES members(id),
  setup_link_issued_at ${T},
  created_at           ${T} NOT NULL,
  updated_at           ${T} NOT NULL,
  CHECK ((razorpay_payment_id IS NULL) = (paid_at IS NULL)),
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
  event_id    ${T} PRIMARY KEY,
  event_type  ${T} NOT NULL,
  order_id    ${T},
  payment_id  ${T},
  outcome     ${T} NOT NULL,
  received_at ${T} NOT NULL
);

-- Online payment attempts for merchandise. See the SQLite schema's version 7 for the states.
CREATE TABLE order_payments (
  id                  ${T} PRIMARY KEY,
  member_id           ${T} NOT NULL REFERENCES members(id),
  order_code          ${T} NOT NULL,
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  currency            ${T} NOT NULL,
  status              ${T} NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','failed','superseded','paid','needs_review','refunded')),
  razorpay_order_id   ${T} NOT NULL UNIQUE,
  -- A payment is recorded once, for one attempt only.
  razorpay_payment_id ${T} UNIQUE,
  payment_method      ${T},
  paid_at             ${T},
  verified_via        ${T} CHECK (verified_via IN ('checkout','webhook','lookup')),
  applied_cents       INTEGER CHECK (applied_cents IS NULL OR applied_cents >= 0),
  failure_reason      ${T},
  failed_at           ${T},
  review_reason       ${T},
  resolved_by         ${T} REFERENCES users(id),
  resolved_at         ${T},
  resolution_note     ${T},
  created_at          ${T} NOT NULL,
  updated_at          ${T} NOT NULL,
  CHECK ((razorpay_payment_id IS NULL) = (paid_at IS NULL)),
  CHECK ((status IN ('paid','needs_review','refunded')) = (razorpay_payment_id IS NOT NULL))
);
-- One open attempt per order, so two clicks cannot start two payments.
CREATE UNIQUE INDEX order_payments_open ON order_payments(order_code) WHERE status IN ('pending','failed');
CREATE INDEX order_payments_member ON order_payments(member_id);

CREATE TABLE order_payment_lines (
  payment_id   ${T} NOT NULL REFERENCES order_payments(id) ON DELETE CASCADE,
  order_id     ${T} NOT NULL REFERENCES orders(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (payment_id, order_id)
);

-- Request counters for rate limiting. The key is a hash; no address is stored.
CREATE TABLE rate_limits (
  bucket_key ${T} PRIMARY KEY,
  count      INTEGER NOT NULL CHECK (count > 0),
  reset_at   BIGINT NOT NULL
);
CREATE INDEX rate_limits_reset ON rate_limits(reset_at);
`;

/** Version 2: volunteering. The same change as SQLite's version 9; see its notes for the request states. */
const V2_VOLUNTEERING = `
ALTER TABLE tasks ADD COLUMN volunteer_slots INTEGER NOT NULL DEFAULT 0 CHECK (volunteer_slots >= 0);

CREATE TABLE volunteer_requests (
  id           ${T} PRIMARY KEY,
  task_id      ${T} NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id    ${T} NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status       ${T} NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  requested_at ${T} NOT NULL,
  reviewed_at  ${T},
  reviewed_by  ${T} REFERENCES users(id),
  review_note  ${T}
);
-- One live request or assignment per member per task.
CREATE UNIQUE INDEX volunteer_requests_live ON volunteer_requests(task_id, member_id) WHERE status IN ('pending','approved');
CREATE INDEX volunteer_requests_member ON volunteer_requests(member_id);
CREATE INDEX volunteer_requests_status ON volunteer_requests(status, requested_at);
`;

/** Version 3: a committee account can be disabled. The same change as SQLite's version 10. */
const V3_ACCOUNT_STATUS = `
ALTER TABLE users ADD COLUMN disabled_at ${T};
`;

export interface PostgresMigration {
  version: number;
  name: string;
  sql: string;
}

export const POSTGRES_MIGRATIONS: PostgresMigration[] = [
  { version: 1, name: "baseline (SQLite schema versions 1 to 8)", sql: V1_BASELINE },
  { version: 2, name: "volunteer requests (SQLite schema version 9)", sql: V2_VOLUNTEERING },
  { version: 3, name: "disabled committee accounts (SQLite schema version 10)", sql: V3_ACCOUNT_STATUS },
];

/** The schema version this code needs. The server refuses to run against an older one. */
export const POSTGRES_SCHEMA_VERSION = POSTGRES_MIGRATIONS.length;

export const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;

/** Every table the application uses. Checked by `npm run db:status` and by the tests. */
export const EXPECTED_TABLES = [
  "users", "sessions", "members", "membership_periods", "events", "tickets", "products", "product_variants",
  "checkouts", "orders", "transactions", "tasks", "announcements", "member_accounts", "member_sessions",
  "account_setup_tokens", "files", "file_contents", "membership_applications", "expense_claims",
  "product_images", "online_applications", "razorpay_webhook_events", "order_payments", "order_payment_lines",
  "rate_limits", "volunteer_requests",
] as const;

/** The uniqueness rules that money, stock and identity depend on. A database missing any of them must not be used. */
export const CRITICAL_UNIQUE_INDEXES = [
  "tickets_one_per_email",
  "membership_applications_open_email",
  "membership_applications_reference",
  "online_applications_open_email",
  "order_payments_open",
  "volunteer_requests_live",
] as const;

/** Columns that must be unique: one payment, one order, one webhook event, one member number. */
export const CRITICAL_UNIQUE_COLUMNS: [table: string, column: string][] = [
  ["users", "email"],
  ["members", "email"],
  ["members", "member_no"],
  ["tickets", "code"],
  ["orders", "code"],
  ["checkouts", "code"],
  ["online_applications", "razorpay_order_id"],
  ["online_applications", "razorpay_payment_id"],
  ["online_applications", "member_id"],
  ["order_payments", "razorpay_order_id"],
  ["order_payments", "razorpay_payment_id"],
  ["razorpay_webhook_events", "event_id"],
  ["expense_claims", "transaction_id"],
];
