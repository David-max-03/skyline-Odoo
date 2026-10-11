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

## Service status

`GET /api/health` answers `200 { "data": { "status": "ok", "database": "postgres" | "sqlite" } }` when the
database is reachable and at the schema version this build needs.

Any route answers `503 { "error": { "code": "database_unavailable", … } }` when the database is not
configured, not reachable or not migrated. The cause is in the server log only. Nothing is marked paid
and no local file is used as a fallback.

## Auth

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `POST /api/auth/login` | public | `loginSchema` | `{ user: SessionUser }` and sets the cookie |
| `POST /api/auth/logout` | public | — | `{ ok }` |
| `GET /api/auth/me` | public | — | `{ user: SessionUser \| null, demo }` |

## Events and tickets

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `GET /api/events` | staff | — | `EventView[]` (`finance` is `null` for O) |
| `POST /api/events` | A, O | `eventInputSchema` | `EventView` (status `draft`) |
| `GET /api/events/:id` | staff | — | `EventDetailView`: `{ event, tickets, breakEven, profitTarget }`. For O, `event.finance`, `breakEven` and `profitTarget` are `null` |
| `PATCH /api/events/:id` | A, O | `eventInputSchema` | `EventView` |
| `POST /api/events/:id/status` | A, O (`cancelled`: A only) | `{ status }` | `EventStatusChange` |
| `POST /api/events/:id/registrations` | staff (`payNow`: A, T) | `staffRegistrationSchema` | `Ticket` |
| `POST /api/tickets/verify` | staff | `{ code, eventId? }` | `CheckInResult` (no change made) |
| `POST /api/tickets/check-in` | staff | `checkInSchema` | `CheckInResult` |
| `POST /api/tickets/:code` | staff¹ | `{ action: "pay" \| "cancel" \| "undo_check_in", method? }` | `{ ticket, refundDueCents }` |

¹ `pay`: A, T. `cancel`: A, O for an unpaid or free ticket; A only for a paid one, because that records a refund. `undo_check_in`: A, O.

**Check-in always answers 200.** Read `outcome`:
`checked_in`, `already_checked_in`, `payment_required`, `wrong_event`, `cancelled`,
`event_cancelled`, `not_found`. `verify` returns `valid` where check-in would admit.
To collect payment and admit in one step, send `collectPayment: true` and a `method` (A, T only; an organizer who sends it gets 403).
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
| `GET /api/transactions?type=&status=&category=&eventId=&voided=1` | A, T | — | `Transaction[]` (`eventId=none` = not tied to an event) |
| `POST /api/transactions` | A, T² | `transactionInputSchema` | `Transaction` |
| `PATCH /api/transactions/:id` | A, T | `transactionInputSchema` | `Transaction` (manual entries only) |
| `POST /api/transactions/:id` | A, T (a `refund` entry: A only) | `{ action: "settle", method? }` or `{ action: "void", reason }` | `Transaction` |
| `GET /api/finance/summary` | A, T | — | `FinanceSummary` |
| `GET /api/dashboard` | staff | — | `DashboardView`. For O: `finance` and `members` are `null`, `cashflow` is empty, money fields of `eventPerformance` are `null`, and only the `overdue_tasks` alert is sent |

² An organizer gets 403 and files an expense claim instead (`POST /api/claims`).

`Transaction.source` is `manual`, `ticket`, `dues`, `order` or `refund`. Only `manual`
entries can be edited; `manual` and `refund` entries can be voided. Settling a `ticket`,
`order` or `dues` entry also marks that ticket, order or membership term as paid.

## Members

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `GET /api/members` | A, T | — | `Member[]` |
| `POST /api/members` | A, T | `memberInputSchema` | `Member` |
| `GET /api/members/:id` | A, T | — | `MemberDetail` (terms, tickets, orders) |
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
| `GET /api/orders` | A, T | — | `Order[]` |
| `POST /api/orders/:id` | A, T | `{ action: "pay" \| "fulfil" \| "cancel", method? }`. Cancelling an order that is already paid is A only (`403` otherwise) | `{ order, refundDueCents }` |

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

## Volunteering

| Method and path | Access | Body | Returns |
|---|---|---|---|
| `GET /api/me/volunteering` | member | — | `MemberVolunteering`: tasks open to volunteers (counts only) and the member's own requests |
| `POST /api/me/volunteering` | member | `{ taskId }` | `MyVolunteerRequest`, always `pending`. `409` if already requested, already assigned or full |
| `POST /api/me/volunteering/:id` | member | `{ action: "withdraw" }` | `MyVolunteerRequest`. Own pending requests only |
| `GET /api/volunteer-requests` | A, O | — | `VolunteerRequest[]`, pending first |
| `POST /api/volunteer-requests/:id` | A, O | `{ action: "approve" }` or `{ action: "reject", reason? }` | `VolunteerRequest`. `409 task_full` when no position remains |

A task is open to volunteers when its `volunteerSlots` (set with the task, `POST`/`PUT /api/tasks`) is above 0, it is
not done, and its event, if any, is published and not over. Positions are taken by approved volunteers only. An
approved volunteer sees the task in `GET /api/me/tasks` and may progress it like any assignee.

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
| `POST /api/order-payments/:id` | A | `{ action: "refunded", note }` | `OrderPaymentRecord` |

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

## Committee accounts (president only)

| Endpoint | Role | Body | Returns |
|---|---|---|---|
| `GET /api/accounts` | A | — | `CommitteeAccount[]` (never anything about passwords) |
| `POST /api/accounts` | A | `accountCreateSchema`: `{ role, name, email }` for a new person, or `{ role, memberId }` for an existing member. Any other key is refused (`422`) | `{ account, setupLink }` |
| `POST /api/accounts/:id` | A | `{ action: "disable" \| "enable" }` | `CommitteeAccount` |
| `PATCH /api/accounts/:id` | A | `{ role }` | `CommitteeAccount`; every session of the account is ended |
| `POST /api/accounts/:id/setup-link` | A | — | `CommitteeSetupLink` (a new one-time password link; cancels an earlier unused one). `403` for another president who already has a password; `409` for one's own or a disabled account |
| `POST /api/auth/staff-setup/check` | public | `{ token }` | `StaffSetupInfo` (name, email, role, expiry). Changes nothing |
| `POST /api/auth/staff-setup` | public | `{ token, password }` (at least 12 characters) | `{ email }`. The link stops working |

No password is ever chosen or shown by the president. A new account is stored unable to
sign in, and `setupLink.path` (`/committee-setup/<token>`) is returned once; only the
SHA-256 of the token is stored, it works once and expires after 72 hours. Skyline sends
no email, so the president passes the link on.

Promoting a member (`memberId`) creates a committee account with the member's name and
email and sets `users.member_id`. Nothing in the member's own records is written, and the
member sign-in keeps its own password. Errors on create: `email_taken`, `member_email`
(the email belongs to a member; promote them instead), `already_committee` (409),
`not_found` (404). Errors on a role change: `own_account`, `same_role`, `last_president`
(409). Each change re-checks inside its transaction that the caller is still an active
president, so presidents acting on each other at once cannot both succeed.

`disable` sets `users.disabled_at`, deletes every session of the account and stops it
signing in (the login error is the same as for a wrong password). The row is kept, so
ledger entries, reviews and check-ins still name their author. `enable` restores sign-in
with the existing password. Errors: `own_account` (409, a president cannot disable
themselves), `already_disabled`, `not_disabled` (409), `not_found` (404). Accounts are
never deleted. The first president is still created from the command line (`admin:create`).

## Who may read what

| Data | A | T | O |
|---|---|---|---|
| Member records (list, one member, addresses) | yes | yes | no |
| Ledger, finance summary, event income and costs, break-even | yes | yes | no |
| Orders, order payments, online membership payments, applications | yes | yes | no |
| Events, registrations, ticket payment status, tasks, volunteer requests | yes | yes¹ | yes |
| Recording a ticket payment | yes | yes | no |
| Cancelling a paid ticket or a paid merchandise order; paying out or voiding any refund; marking an online order payment refunded | yes | no | no |
| Cancelling a whole event | yes | no | no |
| Committee accounts | yes | no | no |

¹ The treasurer reads events and tasks but does not approve volunteer requests.
The staff routes that send this data read it through `src/server/services/staff-views.ts`,
which checks the role again whatever the route declared.

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
