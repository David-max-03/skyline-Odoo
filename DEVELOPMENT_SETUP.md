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
| `SKYLINE_UPLOAD_DIR` | `uploads` beside the database | Where payment screenshots and receipts are stored. Keep it out of any public folder |
| `SKYLINE_UPI_ID` | unset | The club's real UPI ID. When set, the join page shows a payment QR code; when unset, no QR is shown |
| `SKYLINE_UPI_PAYEE` | organisation name | Payee name encoded in the QR code |
| `SKYLINE_RAZORPAY_MODE` | unset | Must be exactly `test` to turn online membership payment on. `live` is refused in this version |
| `SKYLINE_RAZORPAY_KEY_ID` | unset | Razorpay **test** Key ID (`rzp_test_…`). A live key is refused |
| `SKYLINE_RAZORPAY_KEY_SECRET` | unset | The matching Key Secret. Server-side only; never sent to the browser or logged |
| `SKYLINE_RAZORPAY_WEBHOOK_SECRET` | unset | The secret set on the Razorpay webhook. Needed only to accept `/api/webhooks/razorpay` |
| `SKYLINE_DEMO_MODE` | unset | `1` shows the demo sign-ins on `/login` in production |
| `SKYLINE_AUTO_SEED` | unset | `0` stops development from seeding an empty database |
| `SKYLINE_DISABLE_RATE_LIMIT` | unset | `1` turns off rate limits (used by the e2e script) |
| `NEXT_PUBLIC_CURRENCY` | `INR` | ISO currency code for display |
| `NEXT_PUBLIC_LOCALE` | `en-IN` | Number and date formatting |
| `NEXT_PUBLIC_ORG_TZ` | `Asia/Kolkata` | Timezone that decides "today" for due dates and expiry |
| `NEXT_PUBLIC_MEMBERSHIP_FEE_CENTS` | `50000` | Annual dues in minor units |

`NEXT_PUBLIC_*` values are compiled into the browser bundle: rebuild after changing them.
Never commit `.env.local` or the `data/` folder; both are git-ignored.

## Online membership payment (Razorpay, test mode)

Off by default. To turn it on locally:

1. In the Razorpay dashboard, switch to **Test Mode** and generate an API key.
2. Create `.env.local` (Git ignores it) with `SKYLINE_RAZORPAY_MODE=test`, `SKYLINE_RAZORPAY_KEY_ID` and
   `SKYLINE_RAZORPAY_KEY_SECRET`. Never put the values in `.env.example` or any tracked file.
3. Restart the server. `/join` now offers "Pay online" first, with the manual form underneath.

Only test keys (`rzp_test_…`) are accepted; a live key or `SKYLINE_RAZORPAY_MODE=live` leaves online payment off.
If the configuration is wrong, the server log names the variable (never its value) and the join page shows only the manual form.

A membership is created only after the server has verified the payment with Razorpay: the Checkout signature plus the
payment fetched from Razorpay's API, or a signed webhook. The order, amount, currency and `captured` status must all match.

**Webhooks.** Razorpay cannot reach `localhost`. Without a webhook everything still works while the applicant's browser
stays open, and an applicant who returns later (or a treasurer pressing "Check with Razorpay" on the Members page) recovers
a payment that was missed. For a deployed server, add a webhook in the dashboard for
`https://<your-host>/api/webhooks/razorpay` with events `payment.captured`, `order.paid` and `payment.failed`, and set
`SKYLINE_RAZORPAY_WEBHOOK_SECRET` to the secret you chose there.

**Merchandise.** With the same configuration, a signed-in member sees "Pay online" on My orders and on the order
confirmation. The amount is the order's unpaid total from the database. Committee members can still record a cash payment;
both routes settle the same ledger entry, so an item cannot be paid twice. The same webhook URL serves both.

**Test payments.** In test mode Razorpay Checkout accepts its documented test cards and the UPI ID `success@razorpay`
(or `failure@razorpay`). UPI app hand-off on phones and UPI QR codes are live-mode features of Razorpay.

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
