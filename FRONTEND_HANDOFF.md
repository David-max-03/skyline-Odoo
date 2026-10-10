# Frontend handoff

You can redesign every screen without touching business logic. The UI's only link to
the server is `fetch` to `/api/*`, typed by `src/lib/contracts.ts`.

## Safe to change, and not

| Safe to restyle or rewrite | Change with care | Leave alone unless changing behaviour |
|---|---|---|
| `src/app/globals.css` (tokens) | `src/lib/api-client.ts` | `src/server/**` |
| `src/components/**` | `src/lib/contracts.ts` (shared with the server) | `src/app/api/**` |
| `src/app/**/page.tsx`, `layout.tsx` | `src/proxy.ts` | `tests/**`, `scripts/**` |

If you rename or drop a field a page reads, TypeScript will tell you: pages import their
response types from `contracts.ts`. Run `npm run typecheck` after any change.

## Design tokens

All colour, radius, shadow and font decisions are CSS variables in
[`src/app/globals.css`](src/app/globals.css), in three layers:

1. **Primitives** — raw values (`--sky-600`, `--ink-950`).
2. **Semantic** — purpose (`--brand`, `--surface`, `--muted`, `--ok`, `--warn`, `--bad`).
3. **Component** — `--corner-control`, `--corner-card`, `--elevation-card`, `--sidebar-width`.

The `@theme inline` block turns semantic tokens into Tailwind classes. Components use
only those classes; none contains a hex value.

| Class family | Use for |
|---|---|
| `bg-canvas`, `bg-surface`, `bg-sunken` | Page, card, inset backgrounds |
| `text-ink`, `text-body`, `text-muted`, `text-subtle` | Headings, body, secondary, tertiary text |
| `border-line`, `border-line-strong` | Dividers, control borders |
| `bg-brand`, `text-brand`, `bg-brand-soft`, `text-brand-deep` | Primary actions and links |
| `text-ok` / `bg-ok-soft`, `text-warn` / `bg-warn-soft`, `text-bad` / `bg-bad-soft` | Status |
| `bg-night`, `text-on-night`, `text-on-night-muted` | Sidebar and dark panels |
| `bg-accent` | The amber highlight. Decorative only; never text on white |
| `rounded-control`, `rounded-card`, `shadow-card`, `shadow-raised` | Shape and elevation |
| `font-display` (Manrope), `font-sans` (Inter), `.num` | Headings, body, tabular figures |

To re-brand, change the primitives. To re-theme (for example dark mode), redefine the
semantic layer under a selector. Text tokens were chosen to pass 4.5:1 on `surface`;
re-check contrast if you change them. Chart colours (`--chart-1`, `--chart-2`) were
validated for colour-blind separation; re-validate if you change them.

## Components

`src/components/ui.tsx` — presentational, no domain knowledge:

| Component | Props worth knowing |
|---|---|
| `Button`, `LinkButton` | `variant`: primary, secondary, ghost, danger · `size`: sm, md, lg · `loading` · `icon` |
| `Card`, `CardHeader` | `title`, `description`, `action` |
| `PageHeader` | `title`, `description`, `actions`, `back` |
| `TextField`, `SelectField`, `TextAreaField`, `CheckboxField` | `label`, `error`, `hint`, `optional`, `prefix`; label and error are wired for screen readers |
| `FormError`, `Notice` | Form-level error; inline message with `tone` |
| `Badge` | `tone`: neutral, brand, ok, warn, bad · `icon` |
| `Stat`, `Meter` | Headline figure; proportion bar (always pair with the numbers). `Meter size`: sm, md |
| `Table`, `Th`, `Td` | Scrolls horizontally by default. `<Table stack>` turns each row into a labelled card below 640px (see below) |
| `Segmented` | Filter group with optional counts; scrolls on one line on phones |
| `EmptyState`, `ErrorState` | Nothing to show; failed to load (with retry) |
| `TableSkeleton`, `StatSkeleton`, `Skeleton`, `LoadingBlock` | Loading placeholders shaped like the content they stand in for |

**Stacked tables.** Any table a phone user needs should use `stack`. Give each cell
its column name and say how it should sit in the card:

```tsx
<Table stack>
  <thead>…</thead>
  <tbody>
    <tr>
      <Td layout="lead">Title and subtitle; shown first, full width, no label</Td>
      <Td label="Status"><Badge>…</Badge></Td>
      <Td label="Seats" layout="block">Label above, content full width (meters)</Td>
      <Td label="Amount" align="right">…</Td>
      <Td layout="actions"><div className="flex gap-1">buttons</div></Td>
    </tr>
  </tbody>
</Table>
```

A cell with more than one child should wrap them in a single element so they stay
together on the right. Empty cells are hidden. The layout rules are the `.stack-table`
block in `globals.css`; `Table` adds ARIA table roles so screen readers keep row and
column navigation when the display changes.

`overlay.tsx` — `Dialog` (native `<dialog>`), `DialogActions`, `ConfirmDialog`,
`ToastProvider` / `useToast()`.
`domain.tsx` — Skyline vocabulary in one place: `Money`, `EventStatusBadge`,
`PaymentBadge`, `TransactionStatusBadge`, `MemberStatusBadge`, `TaskStatusBadge`,
`OrderStatusBadge`, `FactKindBadge`, `DateBlock` (calendar tile). Change a label or tone
here and it changes everywhere.
`org-shell.tsx` — staff sidebar on desktop; on phones a bottom tab bar (`TABS`: Home,
Events, Check-in, Finance) plus "More", which opens the full menu. Add a page to
`ORG_NAV` and it appears in the sidebar and under More. Keep `TABS` to four.
`public-shell.tsx` — public header, footer and the `Logo`.
`charts.tsx` — `CashflowChart`. `qr-scanner.tsx` — `QrScanner({ onScan })`.
`event-form.tsx`, `transaction-form.tsx` — the two forms used on more than one page.
`session.tsx` — `useSession()`, `useCan(action)`.

## Routes

| Path | File | Reads | Writes |
|---|---|---|---|
| `/` | `app/page.tsx` | public events, announcements | — |
| `/events`, `/events/[id]` | `app/(public)/events/…` | public events | register |
| `/t/[code]` | `app/(public)/t/[code]/page.tsx` | public ticket (polls every 20 s) | — |
| `/shop` | `app/(public)/shop/page.tsx` | public products | — (adds to the browser cart) |
| `/shop/[id]` | `app/(public)/shop/[id]/page.tsx` | one public product | — (adds to the browser cart) |
| `/shop/cart` | `app/(public)/shop/cart/page.tsx` | public products, `auth/me` | `public/checkout`, or `me/checkout` for a signed-in member |
| `/join` | `app/(public)/join/page.tsx` | `public/membership` | `public/applications` (form upload), `public/applications/status` |
| `/news` | `app/(public)/news/page.tsx` | public announcements | — |
| `/login` | `app/login/page.tsx` | `auth/me` | login (members go to `/member`, staff to `/org`) |
| `/activate/[token]` | `app/activate/[token]/page.tsx` | `auth/setup/check` | `auth/setup` |
| `/member` | `app/member/page.tsx` | `me` | — |
| `/member/membership` | `app/member/membership/page.tsx` | `me`, `me/payments` | — |
| `/member/events` | `app/member/events/page.tsx` | `me`, public events | `me/events/:id/register`, `me/tickets/:code/cancel` |
| `/member/orders` | `app/member/orders/page.tsx` | `me/orders` | — |
| `/member/tasks` | `app/member/tasks/page.tsx` | `me/tasks` | `me/tasks/:id` |
| `/member/claims` | `app/member/claims/page.tsx` | `claims` | `claims` (form upload) |
| `/member/announcements` | `app/member/announcements/page.tsx` | `me/announcements` | — |
| `/member/profile` | `app/member/profile/page.tsx` | `me` | `me` (PATCH), `me/password` |
| `/org/claims` | `app/org/claims/page.tsx` | `claims` | `claims` (form upload), `claims/:id` |
| `/org` | `app/org/page.tsx` | `dashboard` | — |
| `/org/events`, `/org/events/[id]` | `app/org/events/…` | events, transactions | events, status, registrations, tickets, transactions |
| `/org/check-in` | `app/org/check-in/page.tsx` | events | check-in |
| `/org/finance` | `app/org/finance/page.tsx` | summary, transactions, events | transactions |
| `/org/members` | `app/org/members/page.tsx` | members | members |
| `/org/tasks` | `app/org/tasks/page.tsx` | tasks, events | tasks |
| `/org/announcements` | `app/org/announcements/page.tsx` | announcements, members | announcements |
| `/org/merch` | `app/org/merch/page.tsx` | products, orders | products, orders |

Three shells: `PublicShell` (public pages and the shop, with the cart link), `MemberShell`
(`/member/*`, nav in `MEMBER_NAV`) and `OrgShell` (`/org/*`, nav in `ORG_NAV`). Each area's
layout sends the wrong kind of account to its own area; the API refuses it regardless.

Shared pieces added for members and the shop: `components/claims-ui.tsx` (claim form with
photo capture, list and review), `components/applications-panel.tsx` (application review
and the one-time setup link), `components/product-editor.tsx`, `components/shop-ui.tsx`
(photo tile, availability badge, quantity stepper, cart link) and `lib/cart.ts` (the
cart, kept in the browser; it holds sizes and quantities only, never a price the server
trusts). Send files with `api(path, { method: "POST", form })`.

Task cards show exactly one button, taken from `TASK_NEXT_ACTION`: Start, Done or Reopen.
Do not add a status picker; the server rejects any other transition.

## Talking to the server

```tsx
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import type { EventSummary } from "@/lib/contracts";

const { data, error, loading, reload } = useApi<EventSummary[]>("/api/events");

try {
  await api("/api/events", { method: "POST", body });
  reload();
} catch (e) {
  setErrors(fieldErrors(e)); // { capacity: "…" } → pass to each field's `error`
  setFormError(errorMessage(e)); // a sentence for <FormError>
}
```

`useApi` keeps the previous data on screen while reloading. A `401` on an `/org` page
sends the browser to `/login?next=…` automatically.

## Things to preserve

- **Every list has loading, error and empty states.** Use the three components above.
- **Hiding a button is not security.** `useCan()` only decides what to show; the server
  decides what is allowed and will return 403.
- **Money in, money out.** Forms accept typed amounts and convert with `parseMoney`;
  display with `<Money>` or `formatMoney`. Never do arithmetic on display strings.
- **Do not compute business numbers in the UI.** Remaining seats, net results,
  break-even and status all arrive computed. Show them; do not re-derive them.
- **Honest wording.** Nothing on screen says a payment was taken or an email was sent,
  because neither happens. Keep it that way unless those integrations are built.
- **Accessibility baseline.** Visible focus ring, labelled controls, 40–44 px targets,
  status never conveyed by colour alone (badges carry text), `prefers-reduced-motion`
  respected. Icons are Lucide SVGs; no emoji.

## Check your work

```bash
npm run typecheck && npm run lint && npm run build
```

Then look at each page at 390 px and at 1360 px wide.
