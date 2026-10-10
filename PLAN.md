# Skyline — implementation plan

Hackathon MVP (24 h) for the "Student Organization System" brief
(`Student_Organization_System.pdf`): one platform for a student club's events,
members, money, merchandise, volunteers and announcements.

## 1. Goal and acceptance criteria

A working, demonstrable web app. "Done" means every item below is observably true.

P0
- A1. Staff can create, edit, publish and cancel events (title, description, venue,
  start/end, capacity, standard price, member price, optional profit target).
  Invalid input is rejected server-side with field errors.
- A2. A student can register for a published event on a public page and receives a
  ticket with a unique code and a QR code. One valid ticket per email per event.
- A3. Registration is refused when the event is full, unpublished, cancelled or over.
  Capacity cannot be exceeded under concurrent requests.
- A4. Staff can check a ticket in by camera scan or by typing the code. The server
  decides the outcome: `checked_in`, `already_checked_in` (with first check-in time),
  `payment_required`, `cancelled`, `event_cancelled`, `not_found`. A ticket can be
  checked in exactly once.
- A5. Staff can record income and expenses with category, status (`settled` /
  `pending`), date, counterparty and optional event link. Amounts are positive
  integers in minor units. A paid ticket registration creates a linked `pending`
  income transaction; recording payment settles that same transaction.
- A6. Net income = settled income − settled expenses. Pending amounts are reported
  separately and never added into "collected" figures. Per-event result uses only
  transactions linked to that event. Totals on every screen equal the sum of the
  underlying transaction rows.
- A7. The dashboard shows member counts, registrations, tickets paid/pending,
  attendance, collected revenue, expenses, net and per-event performance, all read
  from the database, with loading, error and empty states.

P1
- A8. Assistant answers, from live data: most registrations; current financial
  position; which events are profitable; revenue still needed for a profit target;
  tickets needed to break even; overdue volunteer tasks. All numbers come from
  deterministic functions. Each fact is tagged `actual`, `estimate` or
  `recommendation`. The response states which engine answered (`rules` or `claude`).
- A9. Members: register, dues paid/unpaid, expiry and renewal with history; member
  ticket price applies only when email **and** member number match an active member.

P2 (after P0/P1 pass)
- A10. Volunteer tasks (assignee, due date, status, optional event, overdue flag).
- A11. Announcements with a public news board. No email is sent; the UI says so.
- A12. Merchandise: products with per-size stock, public ordering, atomic stock
  decrement, orders create pending income; staff mark paid / fulfilled / cancelled.

Security
- S1. Every staff API call is authorised on the server from the session's user row.
  Roles: `admin`, `treasurer`, `organizer`. The client never supplies a role.
- S2. Unauthenticated staff calls return 401; wrong-role calls return 403.
- S3. Public endpoints expose no member lists, emails, or other attendees' data.
- S4. No secret is committed. `.env*` and `data/` are git-ignored.
- S5. Nothing claims a payment, email or other external action happened unless it did.

## 2. Approach

Stack: Next.js 16.4 (App Router, `cacheComponents` off), React 19, TypeScript,
Tailwind v4, SQLite through Node's built-in `node:sqlite` (Node ≥ 22.5, tested on 24),
zod, `qrcode` (generation), `jsqr` (camera decode), `recharts`, `lucide-react`,
Vitest. Optional `@anthropic-ai/sdk` for the assistant when `ANTHROPIC_API_KEY` is set.

Why not Firebase: no project, credentials or CLI exist in this environment; rules
would need deploying and testing; the demo would depend on the network. SQLite gives
real transactions for capacity, check-in and stock, and runs offline. Trade-off:
needs a host with a persistent disk (not serverless).

Layers (one direction only: UI → API → services → db)
- `src/lib/` — client-safe: `contracts.ts` (zod schemas + TS types), `money.ts`,
  `dates.ts`, `api-client.ts`.
- `src/server/` — server-only: `db.ts` (connection, schema, `tx()`), `auth.ts`
  (scrypt, sessions, role checks), `http.ts` (route wrapper: auth, role, zod body,
  origin check, error envelope, rate limit), `services/*.ts` (all business rules),
  `assistant/*` (tools, rule engine, optional Claude engine), `seed.ts`.
- `src/app/api/**/route.ts` — thin handlers: parse → service → envelope.
- `src/app/(public)/**`, `src/app/org/**` — UI. Pages are client components that
  call the API through `api-client.ts`. `src/components/ui/*` is the design system.

Envelope: success `{ "data": ... }`; failure
`{ "error": { "code", "message", "fields"? } }` with a matching HTTP status.

Data model (SQLite; money = integer minor units; timestamps = ISO-8601 UTC text;
calendar dates = `YYYY-MM-DD` in the org timezone)
- `users`, `sessions` (token stored as SHA-256 hash, expiry)
- `members`, `membership_periods` (one row per paid or unpaid term)
- `events` (status `draft|published|cancelled`)
- `tickets` (code unique; partial unique index on `(event_id, lower(email))` where
  `status='valid'`; `payment_status free|pending|paid`; `checked_in_at`)
- `transactions` (`type income|expense`, `status settled|pending`, `voided_at`,
  nullable links to event, ticket, member, order)
- `tasks`, `announcements`, `products`, `product_variants`, `orders`

Key decisions
- D1. One registration = one ticket row. Ticket payment status is denormalised from
  its linked transaction and both are updated in the same DB transaction.
- D2. Capacity: inside `BEGIN IMMEDIATE`, count valid tickets, compare, insert.
- D3. Check-in: single conditional `UPDATE … WHERE checked_in_at IS NULL AND
  status='valid'`; `changes === 1` is the only success path.
- D4. Unpaid ticket at the door: check-in returns `payment_required`; staff may
  "collect and check in" in one atomic call that settles the transaction.
- D5. Organizers may file expenses only as `pending` (reimbursement claims);
  treasurer/admin settle them.
- D6. Sessions: random 32-byte token in an httpOnly, SameSite=Lax cookie; mutating
  requests also require a same-origin `Origin` header when present and JSON bodies.
- D7. Assistant: a fixed set of read-only tool functions over the DB. Rule engine
  maps a question to tools by intent scoring. Claude engine (if key present) uses the
  same tools through tool-use; on any failure it falls back to the rule engine.
- D8. Break-even = ceil((all linked expenses, settled + pending, − non-ticket income)
  / ticket price), reported at standard price, member price, and observed average
  price. Always tagged `estimate`. Free events report that break-even by ticket
  sales is not possible.

- D9. Editing an event's capacity below its current count of valid tickets is rejected
  with a field error, so an event can never be over capacity after the fact.
- D10. Cancelling an event or a paid ticket or order never deletes income. It records a
  pending `refund` expense per paid item so the ledger shows what is owed back.

Build deliverables that the verification section depends on: npm scripts `typecheck`,
`test`, `seed` and `e2e`; `vitest.config.mts`; `tests/*.test.ts`; `scripts/e2e.ts`.

Non-goals: real payment gateway, real email/SMS, multi-organisation tenancy,
self-service password reset, file/receipt upload, offline check-in.

## 3. Assumptions and risks
- Currency defaults to INR, timezone to Asia/Kolkata; both configurable by env.
- `node:sqlite` is marked experimental in Node 24 but is stable enough for a demo;
  verified working here (SQLite 3.53).
- Camera scanning requires HTTPS or localhost; manual code entry is the fallback.
- The Claude engine cannot be tested live here (no API key). It will be labelled
  untested until a key is supplied.
- Demo accounts with known passwords are created only by the seed script, which is
  auto-run only in development on an empty database.

## 4. Verification

Proof commands (run from the project root):
1. `npm run typecheck` — exits 0.
2. `npm run lint` — exits 0.
3. `npm test` — Vitest service tests on a temporary database, all pass. Covers:
   capacity limit, duplicate registration, member pricing, check-in outcomes
   (including duplicate), payment settle, finance reconciliation, role rules,
   stock decrement, break-even and profit-target maths, assistant intents.
4. `npm run build` — production build succeeds.
5. `npm run e2e` — starts the built app on a temporary database and drives the HTTP
   API through: login → create event → publish → public register → fetch ticket →
   check in → duplicate check-in rejected → invalid code rejected → record income
   and expense → event result reconciles → assistant answer matches the data →
   unauthenticated and wrong-role requests rejected → data survives a restart.

Manual / visual: walk the demo script in a browser at desktop and 390 px width;
confirm QR renders and manual code entry works; confirm no console errors.
