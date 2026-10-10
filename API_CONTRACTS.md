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
| `PATCH /api/tasks/:id` | staff | `{ action: "start" \| "done" \| "reopen" }` | `Task`; 409 `invalid_transition` if the action does not fit the current status |
| `GET /api/me/tasks` | member | — | `Task[]` assigned to the signed-in member |
| `PATCH /api/me/tasks/:id` | member | `{ action }` | `Task`; 404 for any task not assigned to them |
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
| `GET /api/public/membership` | — | `PaymentInstructions` (`upi` is null until `SKYLINE_UPI_ID` is set; `online.available` is true only when Razorpay test mode is configured) |
| `POST /api/public/membership/online` | `onlineApplicationInputSchema` | `OnlineApplicationStart`: the Razorpay order for Checkout and a one-time `accessToken`. Creates no member. `503 payments_not_configured` when Razorpay is off |
| `POST /api/public/membership/online/:id` | `onlineApplicationActionSchema` (`confirm`, `resume`, `failed`, `new_link`; all need `token`) | `OnlineApplicationState`. `setup` (the password link) appears only after the server has verified the payment with Razorpay |
| `POST /api/webhooks/razorpay` | Raw JSON from Razorpay, with `X-Razorpay-Signature` | `{ outcome }`. `401 bad_signature` unless the signature matches the raw body. Not a browser endpoint |
| `POST /api/public/applications` | multipart: `applicationInputSchema` fields + file `evidence` | `ApplicationReceipt` (always `pending`) |
| `POST /api/public/applications/status` | `{ code, email }` | `ApplicationStatusView` |
| `POST /api/auth/setup/check` | `{ token }` | `SetupTokenInfo` |
| `POST /api/auth/setup` | `{ token, password }` | `{ memberNo }`; the link then stops working |

## Membership review and member accounts

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `GET /api/applications` | A, T | — | `MembershipApplication[]` |
| `POST /api/applications/:id` | A, T | `{ action: "approve", paymentReceived: true }` or `{ action: "reject", reason }` | `ApplicationReview` (with the one-time `setup` link on approval) |
| `GET /api/online-applications` | A, T | — | `OnlinePayment[]` (Razorpay payments; those needing review first) |
| `POST /api/online-applications/:id` | A, T | `{ action: "check" }`, `{ action: "activate" }` or `{ action: "refunded", note }` | `OnlineReconcileResult` (with `setup` when the action created the member) |
| `POST /api/members/:id/setup-link` | A, T | — | `SetupLink` |
| `GET /api/files/:id` | A, T | — | the image bytes |
| `GET /api/me` | member | — | `MemberDetail` for the signed-in member |

`POST /api/auth/login` takes `{ email, password }`, where `email` may be a staff email,
a member's email or a member ID such as `SKY-M-0001`. `SessionUser.role` is `"member"`
for member accounts, with `memberId` and `memberNo` set. Every staff endpoint answers a
member account with 403.

Registration and orders never take payment: they create a `pending` ledger entry that
staff settle. Member prices apply only when `memberNo` and `email` both match a member
whose paid term covers today; a mismatch is a `422` on `memberNo`.

## Member area (`role: "member"` only; the member is always the signed-in one)

| Method and path | Body | Returns |
|---|---|---|
| `PATCH /api/me` | `{ phone, studentId }` (nothing else can change) | `MemberDetail` |
| `POST /api/me/password` | `{ currentPassword, newPassword }` | `{ ok }`; other sessions are ended |
| `GET /api/me/payments` | — | `MemberPayment[]` |
| `GET /api/me/announcements` | — | announcements, including member-only ones |
| `POST /api/me/events/:id/register` | none | `{ code, priceCents, paymentStatus, isMember }`; price decided by the server |
| `POST /api/me/tickets/:code/cancel` | none | `{ code, status }`; own, unpaid, unused tickets only |
| `POST /api/me/checkout` | `{ items: [{ variantId, quantity }] }` | `ShopOrder` |
| `GET /api/me/orders` | — | `ShopOrder[]` |

## Shop

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `GET /api/public/products` · `GET /api/public/products/:id` | public | — | `PublicProduct[]` · `PublicProduct` |
| `GET /api/public/product-images/:id` | public | — | image bytes (product photos only) |
| `POST /api/public/checkout` | public | `{ items: [{ variantId, quantity }], name, email, memberNo? }` | `ShopOrder` |
| `POST /api/products/:id/images` | A, T | multipart, file `image` | `Product` |
| `DELETE /api/products/:id/images/:imageId` | A, T | — | `Product` |
| `POST /api/products/:id/variants` | A, T | `{ size, stock }` | `Product` |
| `POST /api/me/orders/:code/pay` | member | `orderPaymentActionSchema`: `start`, `confirm` (Checkout result), `check`, `failed`. No amount is accepted | `OrderPaymentState`. The order is paid only after the server verifies the payment with Razorpay. `404` for an order that is not the member's |
| `GET /api/order-payments` | A, T | — | `OrderPaymentRecord[]` (online merchandise payments; those needing a refund first) |
| `POST /api/order-payments/:id` | A, T | `{ action: "refunded", note }` | `OrderPaymentRecord` |

A checkout is all-or-nothing and is priced on the server from the product rows; price,
total and payment fields sent by a client are dropped by the schema. Every line comes
back `paymentStatus: "pending"`. Staff record payment and hand-over per line with the
existing `POST /api/orders/:id`. `productInputSchema` and `productUpdateSchema` now take
`category`.

## Expense claims

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `GET /api/claims` | any signed-in account | — | `ClaimList`: all claims for A and T, own claims otherwise |
| `POST /api/claims` | staff, and members with an assigned task | multipart: `claimInputSchema` fields + file `evidence` (required) | `ExpenseClaim` |
| `POST /api/claims/:id` | A, T, never the claimant | `{ action: "start_review" }`, `{ action: "approve", note? }`, `{ action: "reject", reason }` or `{ action: "pay", method }` | `ExpenseClaim` |

`GET /api/files/:id` serves a receipt to A, T and the claimant only. `POST
/api/transactions` is now A and T only: organizers file claims instead.

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
