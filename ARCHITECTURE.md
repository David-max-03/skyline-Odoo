# Architecture

Skyline is one Next.js application backed by one SQLite file. There are no other services.

```
Browser ── pages (client components) ── fetch ──► /api/* route handlers
                                                    │  src/server/http.ts: session, role, origin, zod, rate limit
                                                    ▼
                                             src/server/services/*   ← every business rule lives here
                                                    ▼
                                             src/server/db.ts ──► data/skyline.db (SQLite, WAL)
```

Calls go in one direction only: UI → API → services → database. Services never import
from `src/app` or `src/components`, and UI code never imports from `src/server`.

## Stack and why

| Choice | Reason |
|---|---|
| Next.js 16 (App Router), React 19, TypeScript | One deployable for pages and API. `cacheComponents` is off: every screen shows live data. |
| SQLite through Node's built-in `node:sqlite` | Real transactions for capacity, check-in and stock; no credentials; runs offline. Needs Node ≥ 22.5. |
| zod | One schema per input, shared by server validation and TypeScript types. |
| Tailwind CSS v4 | Styling from design tokens in `src/app/globals.css`. |
| `qrcode`, `jsqr` | QR generated on the server as SVG; decoded in the browser from the camera. |
| Vitest | Service tests against a temporary database. |
| `@anthropic-ai/sdk` (optional) | Used only when `ANTHROPIC_API_KEY` is set. |

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
  assistant/          tools.ts (read-only data tools), rules.ts, claude.ts, index.ts
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
| `events` | Draft → published → cancelled | `capacity > 0`, prices `>= 0` |
| `tickets` | One row per registration | Unique `code`; unique `(event_id, email)` among valid tickets |
| `transactions` | The ledger | `amount_cents > 0`; `status` settled or pending; `voided_at` |
| `products`, `product_variants`, `orders` | Merchandise | `stock >= 0` enforced by the database |
| `tasks`, `announcements` | Volunteer work and posts | |

## Rules that hold everywhere

**The ledger is the only source of money figures.** Every dashboard tile, event result
and assistant answer is a `SUM` over non-voided `transactions` rows.
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
- Login, public forms, ticket lookup and the assistant are rate-limited per address
  (in memory, per process).
- All SQL uses bound parameters.

## The assistant

`src/server/assistant/tools.ts` defines ten read-only tools. Each returns a summary, a
list of facts tagged `actual`, `estimate` or `recommendation`, and the records it read.
All arithmetic is in the tools or in `services/analysis.ts`.

- **Rule engine** (`rules.ts`, the default): keyword scoring picks a tool, a title match
  picks the event, a regex reads an amount. The answer is the tool's own summary.
- **Claude engine** (`claude.ts`, when `ANTHROPIC_API_KEY` is set): Claude chooses tools
  through tool use and writes the wording. The facts shown beside the answer come
  straight from the tool results, not from the model's text. Any failure, refusal or
  answer that used no tool falls back to the rule engine, and the response says so.

Every response names the engine that produced it.

## Known limits

- No payment gateway and no email or SMS. Payments are recorded by staff; announcements
  go on the news board. The UI states this wherever it matters.
- One organisation per installation. No self-service password reset or account
  management UI: accounts are created by the seed script.
- The Claude engine has not been exercised against the live API in this build (no key
  was available). The rule engine is covered by tests.
- Public sign-up reveals whether an email is already a member ("already on the list").
- Rate limits and the single SQLite connection assume one server process.
- The interface is light-theme only. Tokens are structured so a dark theme can be added
  in `globals.css` without touching components.
