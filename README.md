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
| Sign-ups in a spreadsheet | Member list with dues, expiry, renewal reminders and history. Member prices need a matching member number and email |
| Chasing receipts | Organizers file expense claims; the treasurer settles them |
| Announcements in WhatsApp groups | One dated news board, plus a copyable member mailing list |
| Hoodie orders on paper | Public shop with live stock per size; stock cannot be oversold |
| Fundraiser plans in someone's head | Task board with owners, due dates and overdue flags |
| "How are we doing?" | Dashboard of what needs attention, and an assistant that answers from the records and marks each figure Actual or Estimate |

## What it does not do

No payment gateway and no email. Payments are recorded by staff when money changes
hands; announcements go on the news board. The interface says so wherever it matters.

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
