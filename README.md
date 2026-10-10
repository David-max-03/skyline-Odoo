# Skyline

One system to run a student organisation: events and tickets, members, money,
merchandise, volunteers and announcements. Built for the "Student Organization System"
brief (`Student_Organization_System.pdf`).

```bash
npm install
npm run dev        # http://localhost:3000, demo data loads on first start
```

Sign in at `/login` with a demo account (password `skyline-demo`), for example
`president@skyline.club`.

## What it does

| The club's problem | In Skyline |
|---|---|
| Tickets sold at the door for cash | Public event pages, member and standard prices, a seat limit that holds under load, QR tickets, check-in by camera or typed code, each ticket admitted once |
| Budget in a notebook | One ledger. Collected and paid amounts make the balance; anything pending is shown separately. Per-event results, break-even and profit-target tracking |
| Sign-ups in a spreadsheet | People apply online with their payment reference and a screenshot; the treasurer confirms the money arrived before anyone becomes a member. Member list with dues, expiry, renewal reminders and history |
| Members with no way in | Member accounts: sign in with a member ID, see tickets and QR codes, orders, tasks, claims, payments and member-only news. Members cannot reach any committee function |
| Chasing receipts | Volunteers and committee members file expense claims with a photo of the receipt; the treasurer approves and pays through the same ledger |
| Announcements in WhatsApp groups | One dated news board, plus a copyable member mailing list |
| Hoodie orders on paper | A shop with search, categories, product pages, a cart and checkout. Prices are set on the server and stock cannot be oversold |
| Fundraiser plans in someone's head | Task board with owners, due dates and overdue flags. Each task has one button: Start, Done or Reopen |
| "How are we doing?" | Dashboard of what needs attention, with break-even and profit-target figures on every event |

## What it does not do

No payment gateway and no email. Payments are recorded by staff when money changes
hands; announcements go on the news board. The interface says so wherever it matters.
The payment QR code on the join page only asks a UPI app to pay the club; scanning it,
or uploading a screenshot, never confirms a payment. New members get a one-time
password link from the committee member who approved them.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — how it is built and the rules that always hold
- [API_CONTRACTS.md](API_CONTRACTS.md) — every endpoint
- [FRONTEND_HANDOFF.md](FRONTEND_HANDOFF.md) — restyling without touching logic
- [DEVELOPMENT_SETUP.md](DEVELOPMENT_SETUP.md) — commands, environment, demo script, deployment

## Verify

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run e2e
```
# skyline-Odoo
