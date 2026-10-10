# Development setup

## Requirements

- Node.js 22.5 or newer (built and tested on 24). SQLite is built into Node; there is no
  database to install.
- npm.

## First run

```bash
npm install
npm run dev          # http://localhost:3000
```

On first start in development, an empty database is filled with demo data automatically.
Sign in at `/login` with one of the demo accounts shown there (password `skyline-demo`):

| Role | Email | Can |
|---|---|---|
| President (admin) | `president@skyline.club` | Everything |
| Treasurer | `treasurer@skyline.club` | Money, members, merchandise; cannot manage events |
| Event organizer | `events@skyline.club` | Events, check-in, tasks, announcements; files expense claims |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run seed` | **Wipes the database** and reloads the demo data |
| `npm run seed -- --if-empty` | Seeds only when there are no accounts |
| `npm test` | Service tests on a temporary database |
| `npm run typecheck` | Generates route types, then `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm start` | Serves the production build |
| `npm run e2e` | Drives the built app over HTTP on a temporary database (run `build` first) |

Full verification:

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run e2e
```

## Environment variables

Copy `.env.example` to `.env.local`. Everything is optional in development.

| Variable | Default | Purpose |
|---|---|---|
| `SKYLINE_DB_PATH` | `./data/skyline.db` | Where the SQLite file lives |
| `ANTHROPIC_API_KEY` | unset | Enables the Claude engine for the assistant. Unset = rule-based engine |
| `SKYLINE_ASSISTANT_MODEL` | `claude-opus-5-5` | Model used when the key is set |
| `SKYLINE_DEMO_MODE` | unset | `1` shows the demo sign-ins on `/login` in production |
| `SKYLINE_AUTO_SEED` | unset | `0` stops development from seeding an empty database |
| `SKYLINE_DISABLE_RATE_LIMIT` | unset | `1` turns off rate limits (used by the e2e script) |
| `NEXT_PUBLIC_CURRENCY` | `INR` | ISO currency code for display |
| `NEXT_PUBLIC_LOCALE` | `en-IN` | Number and date formatting |
| `NEXT_PUBLIC_ORG_TZ` | `Asia/Kolkata` | Timezone that decides "today" for due dates and expiry |
| `NEXT_PUBLIC_MEMBERSHIP_FEE_CENTS` | `50000` | Annual dues in minor units |

`NEXT_PUBLIC_*` values are compiled into the browser bundle: rebuild after changing them.
Never commit `.env.local` or the `data/` folder; both are git-ignored.

## The five-minute demo

Reset first so the numbers below are right: `npm run seed`, then `npm run dev`.

1. **Dashboard** — sign in as the President. Point at "Needs attention": 3 overdue
   tasks, expenses waiting to be paid, unpaid tickets, memberships to renew, low stock.
   Each links to where it gets fixed. Then the cash position and event performance.
2. **Create an event** — Events → New event. Name "Spring Gala", any venue, a date a few
   days out, 50 seats, price 500, member price 400, profit target 10000. It saves as a
   draft. Press **Publish**.
3. **Register a student** — press **Public page** (opens the public site). Fill in a name
   and email, reserve the ticket. The ticket page shows the QR code and "Not paid yet".
4. **Verify the ticket** — back in the staff tab, **Check-in**. Start the camera and scan
   the QR from the other window or a phone, or type the code. It reports "Payment
   needed". Press **Payment received, check in**. Scan again: **Already used**.
   Type `SKY-22222-22222`: **Not a valid ticket**.
5. **Record an expense** — open the event → Money → Record income or expense. Venue,
   3000, "Hall hire". The result tile changes to −₹2,500 and the break-even card now
   says how many more tickets are needed.
6. **Financial results** — Finance. Collected, paid out, what is left, and pending kept
   apart. The ledger shows the ticket payment and the hall hire.
7. **Ask the assistant** — "How many tickets must the Spring Gala sell to break even?"
   The answer (6 in total, 5 more) matches the break-even card on the event page, with
   each figure marked Actual or Estimate. Then try "Which events are profitable?".

To show role enforcement, sign in as the Treasurer: there is no "New event" button, and
calling the API directly returns 403.

For camera scanning from a phone, the site must be served over HTTPS (or opened on
`localhost`). Typing the code always works.

## Deploying

Skyline needs a Node host with a persistent disk for the SQLite file: a small VM, or a
container platform with a mounted volume. It will not keep data on serverless hosts
with an ephemeral filesystem.

```bash
npm ci && npm run build
SKYLINE_DB_PATH=/var/lib/skyline/skyline.db npm start
```

- Serve it over HTTPS so the session cookie is marked `Secure` and the camera works.
- Run one server process (rate limits and the database connection are per process).
- Back up the database file (and its `-wal` companion) or use `sqlite3 … ".backup"`.
- Production does not seed itself. `npm run seed` creates the demo accounts with a
  published password: use it for a demo, not for a real club. Real accounts are created
  with `createUser` in `src/server/auth.ts`; there is no account-management screen yet.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No such built-in module: node:sqlite` | Node is older than 22.5. Upgrade Node. |
| `ExperimentalWarning: SQLite is an experimental feature` | Expected on some Node versions; harmless. |
| Camera will not start | Not HTTPS or permission denied. Use the code box. |
| `Too many attempts` | The rate limit; wait a minute or restart the dev server. |
| Numbers look stale after editing the DB by hand | Reload the page; nothing is cached server-side. |
