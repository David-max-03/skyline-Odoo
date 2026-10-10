# Architecture

Skyline is one Next.js application backed by one database: PostgreSQL in production, a
SQLite file for local development and tests. The same services and SQL run on both.

```
Browser ── pages (client components) ── fetch ──► /api/* route handlers
                                                    │  src/server/http.ts: session, role, origin, zod, rate limit
                                                    ▼
                                             src/server/services/*   ← every business rule lives here
                                                    ▼
                                             src/server/db.ts ──► PostgreSQL (production) or data/skyline.db (local)
```

Calls go in one direction only: UI → API → services → database. Services never import
from `src/app` or `src/components`, and UI code never imports from `src/server`.

## Stack and why

| Choice | Reason |
|---|---|
| Next.js 16 (App Router), React 19, TypeScript | One deployable for pages and API. `cacheComponents` is off: every screen shows live data. |
| PostgreSQL (`pg`) in production, SQLite (`node:sqlite`) locally | One asynchronous interface in `src/server/db.ts` with a driver for each (`src/server/db/`). Real transactions for capacity, check-in, stock and payments. Write transactions are serialised on both: SQLite's single writer, and one advisory lock per transaction on PostgreSQL. Local development needs no credentials and runs offline. |
| zod | One schema per input, shared by server validation and TypeScript types. |
| Tailwind CSS v4 | Styling from design tokens in `src/app/globals.css`. |
| `qrcode`, `jsqr` | QR generated on the server as SVG; decoded in the browser from the camera. |
| Vitest | Service tests against a temporary database. |

Firebase was considered and not used: this environment had no project or credentials,
security rules would have needed deploying and testing, and the demo would have depended
on the network. The trade-off is that Skyline needs a host with a persistent disk.

## Directory map

```
src/lib/            Safe on client and server
  contracts.ts        Every API input schema and response type. Start here.
  money.ts            Minor units ↔ display strings
  dates.ts            Timezone-safe formatting and date maths
  api-client.ts       api(), useApi(), ApiError
src/server/         Server only
  db.ts               Connection, schema, tx(), clock, id and code generators
  auth.ts             scrypt hashing, sessions
  http.ts             staffRoute / publicRoute wrappers, rate limits
  errors.ts           AppError and requireRole
  services/           events, tickets, finance, members, merch, tasks,
                      announcements, analysis, dashboard
  seed.ts             Demo data
src/app/api/        Route handlers, a few lines each
src/app/org/        Staff pages          src/app/(public)/  Public pages
src/components/     UI kit, shells, forms, chart, scanner
tests/              Vitest service tests  scripts/  seed.ts, e2e.ts
```

## Data model

Money is an integer number of minor units. Timestamps are ISO-8601 UTC text. Calendar
dates are `YYYY-MM-DD` in the organisation's timezone. The schema is in `src/server/db.ts`.

| Table | Purpose | Notable constraints |
|---|---|---|
| `users`, `sessions` | Staff accounts and sign-ins | Session token stored as SHA-256; role read from `users` on every request |
| `members`, `membership_periods` | People and their terms | Status is derived from terms, never stored |
| `member_accounts`, `member_sessions` | Member passwords and sign-ins | Separate from staff tables, so a member session can only ever resolve to the role `member` |
| `account_setup_tokens` | One-time password-setup links | Only the SHA-256 is stored; single use; 72-hour expiry; a new link revokes the old one |
| `membership_applications` | People who say they have paid the fee | One open application per email; a UPI or bank reference can be used once. `channel` is `manual` or `razorpay` |
| `online_applications` | Membership fees paid through Razorpay | One Razorpay order per row; a payment ID is unique, so it pays for one membership. Becomes a member only after the server verifies the payment (`src/server/services/online-applications.ts`) |
| `order_payments`, `order_payment_lines` | Online payment attempts for merchandise | One Razorpay order per attempt and one open attempt per checkout; a verified payment settles the same ledger rows staff settle by hand (`src/server/services/order-payments.ts`) |
| `razorpay_webhook_events` | Webhook deliveries that passed signature verification | Keyed by Razorpay's event ID, so a repeat delivery does nothing |
| `expense_claims` | Reimbursement requests | Receipt photo required; one linked ledger row at most |
| `checkouts`, `product_images` | Items bought together; product photos | `orders` rows are the lines of a checkout |
| `files` | Uploaded evidence and product photos (bytes in `file_contents` on PostgreSQL; on disk under `<db folder>/uploads` for local SQLite) | JPEG, PNG or WebP by content, 5 MB cap, random id as the file name |
| `events` | Draft → published → cancelled | `capacity > 0`, prices `>= 0` |
| `tickets` | One row per registration | Unique `code`; unique `(event_id, email)` among valid tickets |
| `transactions` | The ledger | `amount_cents > 0`; `status` settled or pending; `voided_at` |
| `products`, `product_variants`, `orders` | Merchandise | `stock >= 0` enforced by the database |
| `tasks`, `announcements` | Volunteer work and posts | |

## Rules that hold everywhere

**The ledger is the only source of money figures.** Every dashboard tile, event result
and analysis card is a `SUM` over non-voided `transactions` rows.
`settled` means money moved; `pending` means it is owed. Net = settled income − settled
expenses. Pending amounts are always reported separately.

**A ticket, order or membership term cannot disagree with the ledger.** Creating one
writes its ledger row in the same database transaction. Settling goes through one
function, `applySettlement` in `services/finance.ts`, which updates the ledger row and
the record it pays for together.

**Capacity.** Registration runs inside `BEGIN IMMEDIATE`: count valid tickets, compare
with capacity, insert. Editing capacity below the registered count is refused.

**Check-in happens once.** A single `UPDATE … WHERE checked_in_at IS NULL AND status =
'valid'`; only `changes === 1` counts as admitted.

**Stock.** `UPDATE … SET stock = stock - ? WHERE stock >= ?`, backed by a `CHECK`.

**Nobody becomes a member on their own say-so.** A public application creates a
pending row and nothing else: no member, no member ID, no ledger entry. The QR code on
the join page only encodes a request to pay the club's UPI ID; scanning it, and
uploading a screenshot, verify nothing. An admin or treasurer must approve with
`paymentReceived: true`, and only then does one transaction create the member, a paid
term, a settled dues row and a password-setup link.

**Members are not staff.** `staffRoute` refuses the role `member` on every staff
endpoint, including those open to all staff roles, and `requireRole` refuses it in
every service. Member endpoints use `memberRoute`, which takes the member id from the
session and never from the request.

**A claim reaches the ledger once.** An expense claim is a request with a required
receipt photo and is not in the ledger. Approval writes one pending expense row and
links it (`expense_claims.transaction_id`, unique). Paying that row, from the claims
screen or the finance screen, marks the claim paid. The row cannot be edited or voided
by hand, and nobody reviews their own claim.

**Checkout is all-or-nothing and priced on the server.** A cart is a list of sizes and
quantities. In one transaction each size is taken with the conditional stock update and
priced from the product row; if any size is short, everything rolls back. Each line
stores the name, size and price it was sold at.

**Task status moves one step.** `transitionTask` accepts start, done or reopen, and its
UPDATE names the status it expects. A member can take those steps on tasks assigned to
them and nothing else.

**Cancelling never deletes income.** Unpaid charges are voided. For anything already
paid, a pending `refund` expense is recorded so the books show what is owed back.

## Security

- Passwords: scrypt with a per-user salt. Sessions: random 32-byte token in an
  httpOnly, SameSite=Lax cookie, `Secure` over HTTPS, seven-day expiry.
- Authorisation happens twice: the route wrapper checks the role before reading the
  request body, and each service calls `requireRole` again, so a rule holds whichever
  route or script calls the service. The matrix is `CAN` in `src/lib/contracts.ts`.
- The UI hides controls by role for convenience only. `src/proxy.ts` redirects
  signed-out visitors away from `/org/*`; it is not the security boundary.
- Mutating requests with a foreign `Origin` header are refused.
- Public endpoints return purpose-built shapes (`PublicEvent`, `PublicTicket`…) with
  no emails or member lists. Member pricing needs both the email and the member number.
- Login, public forms and ticket lookup are rate-limited per address
  (in memory, per process).
- All SQL uses bound parameters.
- Uploads are private. They are stored outside the web root, typed by their first
  bytes, and served only by `/api/files/:id` after `readEvidence` has checked the
  caller, with `nosniff`, a sandboxing CSP and `no-store`.
- Password-setup links are shown once to the staff member who issued them. There is no
  email service, so that person passes the link on.

## Known limits

- No payment gateway and no email or SMS. Payments are recorded by staff; announcements
  go on the news board. The UI states this wherever it matters.
- A member's tickets and orders are matched by member id or by the email on the record.
  If staff change a member's email to one used earlier for guest purchases, those
  purchases appear on that member's account.
- The cart lives in the browser. It does not follow a member to another device.
- Sign-in is rate-limited per address, not per account.
- Product photos must be uploaded by the committee; none ship with the app.
- One organisation per installation. No self-service password reset or account
  management UI: accounts are created by the seed script.
- Public sign-up reveals whether an email is already a member ("already on the list").
- Rate limits are counted in the database (`rate_limits`), so they hold across server instances.
- Upload bytes are in the database (`file_contents`) on PostgreSQL, and on disk for local SQLite.
- The PostgreSQL schema is in `src/server/db/postgres-schema.ts` and is applied only by `npm run db:migrate`.
- The interface is light-theme only. Tokens are structured so a dark theme can be added
  in `globals.css` without touching components.
