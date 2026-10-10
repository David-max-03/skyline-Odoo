# API contracts

The authoritative definitions are in [`src/lib/contracts.ts`](src/lib/contracts.ts): a zod
schema for every request body and a TypeScript interface for every response. This file
is the map.

## Conventions

- JSON in, JSON out. Send `Content-Type: application/json` with a body.
- Success: `200 { "data": … }`.
- Failure: `{ "error": { "code": string, "message": string, "fields"?: { [field]: string } } }`.
  `message` is written to be shown to a person. `fields` is present for validation errors.
- Money: integer minor units in fields ending `Cents` (`50000` = ₹500.00).
- Timestamps: ISO-8601 UTC in fields ending `At`. Calendar dates: `YYYY-MM-DD` in fields ending `On`.
- Authentication: the `skyline_session` cookie set by `POST /api/auth/login`.

| Status | Codes you will see |
|---|---|
| 400 | `invalid_json` |
| 401 | `unauthorized`, `invalid_credentials` |
| 403 | `forbidden`, `bad_origin` |
| 404 | `not_found` |
| 409 | `sold_out`, `already_registered`, `registration_closed`, `out_of_stock`, `not_pending`, `linked_entry`, `event_cancelled`, `has_registrations`, `email_taken`, `dues_outstanding`, `payment_required`, … |
| 422 | `invalid` (with `fields`) |
| 429 | `rate_limited` |

Roles: **A** admin, **T** treasurer, **O** organizer. "Staff" means any of the three.

## Auth

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `POST /api/auth/login` | public | `loginSchema` | `{ user: SessionUser }` and sets the cookie |
| `POST /api/auth/logout` | public | — | `{ ok }` |
| `GET /api/auth/me` | public | — | `{ user: SessionUser \| null, demo }` |

## Events and tickets

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `GET /api/events` | staff | — | `EventSummary[]` |
| `POST /api/events` | A, O | `eventInputSchema` | `EventSummary` (status `draft`) |
| `GET /api/events/:id` | staff | — | `{ event, tickets: Ticket[], breakEven: BreakEvenAnalysis, profitTarget: ProfitTargetAnalysis \| null }` |
| `PATCH /api/events/:id` | A, O | `eventInputSchema` | `EventSummary` |
| `POST /api/events/:id/status` | A, O | `{ status }` | `EventStatusChange` |
| `POST /api/events/:id/registrations` | staff | `staffRegistrationSchema` | `Ticket` |
| `POST /api/tickets/verify` | staff | `{ code, eventId? }` | `CheckInResult` (no change made) |
| `POST /api/tickets/check-in` | staff | `checkInSchema` | `CheckInResult` |
| `POST /api/tickets/:code` | staff¹ | `{ action: "pay" \| "cancel" \| "undo_check_in", method? }` | `{ ticket, refundDueCents }` |

¹ `pay`: any staff. `cancel`, `undo_check_in`: A, O.

**Check-in always answers 200.** Read `outcome`:
`checked_in`, `already_checked_in`, `payment_required`, `wrong_event`, `cancelled`,
`event_cancelled`, `not_found`. `verify` returns `valid` where check-in would admit.
To collect payment and admit in one step, send `collectPayment: true` and a `method`.
Codes are accepted in any case, with or without dashes, spaces or the `SKY` prefix, or
as a ticket URL.

```http
POST /api/tickets/check-in
{ "code": "SKY-7KQ2M-9XWPA", "eventId": "evt_abc", "collectPayment": false }

200 { "data": { "outcome": "already_checked_in",
                "message": "This ticket has already been used.",
                "ticket": { "code": "SKY-7KQ2M-9XWPA", "attendeeName": "Riya Sharma",
                            "checkedInAt": "2026-10-10T12:31:04.112Z", "checkedInByName": "Rohan Das", … } } }
```

## Finance

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `GET /api/transactions?type=&status=&category=&eventId=&voided=1` | staff | — | `Transaction[]` (`eventId=none` = not tied to an event) |
| `POST /api/transactions` | staff² | `transactionInputSchema` | `Transaction` |
| `PATCH /api/transactions/:id` | A, T | `transactionInputSchema` | `Transaction` (manual entries only) |
| `POST /api/transactions/:id` | A, T | `{ action: "settle", method? }` or `{ action: "void", reason }` | `Transaction` |
| `GET /api/finance/summary` | staff | — | `FinanceSummary` |
| `GET /api/dashboard` | staff | — | `Dashboard` |

² Organizers may only create `type: "expense"` with `status: "pending"` (a claim).

`Transaction.source` is `manual`, `ticket`, `dues`, `order` or `refund`. Only `manual`
entries can be edited; `manual` and `refund` entries can be voided. Settling a `ticket`,
`order` or `dues` entry also marks that ticket, order or membership term as paid.

## Members

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `GET /api/members` | staff | — | `Member[]` |
| `POST /api/members` | A, T | `memberInputSchema` | `Member` |
| `GET /api/members/:id` | staff | — | `MemberDetail` (terms, tickets, orders) |
| `PATCH /api/members/:id` | A, T | `memberUpdateSchema` | `Member` |
| `POST /api/members/:id` | A, T | `{ action: "renew" \| "collect_dues", duesPaid?, method? }` | `Member` |

`Member.status`: `active`, `expiring` (paid term ends within 30 days), `lapsed`, `unpaid`.

## Tasks, announcements, merchandise

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `GET /api/tasks` · `POST /api/tasks` | staff | `taskInputSchema` | `Task[]` · `Task` |
| `PUT /api/tasks/:id` | staff | `taskInputSchema` | `Task` |
| `PATCH /api/tasks/:id` | staff | `{ status }` | `Task` |
| `DELETE /api/tasks/:id` | A, O | — | `{ ok }` |
| `GET /api/announcements` | staff | — | `Announcement[]` |
| `POST /api/announcements` | A, O | `announcementInputSchema` | `Announcement` |
| `DELETE /api/announcements/:id` | A, O | — | `{ ok }` |
| `GET /api/products` | staff | — | `Product[]` |
| `POST /api/products` | A, T | `productInputSchema` | `Product` |
| `PATCH /api/products/:id` | A, T | `productUpdateSchema` | `Product` |
| `POST /api/products/:id` | A, T | `{ variantId, stock }` | `Product` |
| `GET /api/orders` | staff | — | `Order[]` |
| `POST /api/orders/:id` | A, T | `{ action: "pay" \| "fulfil" \| "cancel", method? }` | `{ order, refundDueCents }` |

## Assistant

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `GET /api/assistant` | staff | — | `{ engine, label, suggestions }` |
| `POST /api/assistant` | staff | `{ question }` | `AssistantAnswer` |

`AssistantAnswer.engine` is `"rules"` or `"claude"`. Each entry in `facts` has
`kind: "actual" | "estimate" | "recommendation"`. `notice` is set when the assistant made
an assumption (for example, which event) or fell back to the rule engine.

## Public (no session)

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/public/events` | — | `PublicEvent[]` (published, not ended) |
| `GET /api/public/events/:id` | — | `PublicEvent` |
| `POST /api/public/events/:id/register` | `registrationInputSchema` | `{ code, priceCents, paymentStatus, isMember }` |
| `GET /api/public/tickets/:code` | — | `PublicTicket` (includes `qrSvg`; no email) |
| `GET /api/public/announcements` | — | `PublicAnnouncement[]` (audience `everyone` only) |
| `GET /api/public/products` | — | `PublicProduct[]` |
| `POST /api/public/orders` | `orderInputSchema` | `PublicOrder` |
| `POST /api/public/join` | `memberJoinSchema` | `JoinResult` |

Registration and orders never take payment: they create a `pending` ledger entry that
staff settle. Member prices apply only when `memberNo` and `email` both match a member
whose paid term covers today; a mismatch is a `422` on `memberNo`.

## Adding an endpoint

1. Add the input schema and response type to `src/lib/contracts.ts`.
2. Put the rule in a function under `src/server/services/`, starting with `requireRole`.
3. Add `src/app/api/<path>/route.ts`:

```ts
import { CAN, myInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { doTheThing } from "@/server/services/things";

export const POST = staffRoute(CAN.manageEvents, { body: myInputSchema }, ({ body, params, user }) =>
  doTheThing(params.id, body, user),
);
```

4. Add a test in `tests/` and a row to this file.
