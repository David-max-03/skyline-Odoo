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
| `Stat`, `Meter` | Headline figure; proportion bar (always pair with the numbers) |
| `Table`, `Th`, `Td` | Scrolls horizontally on small screens |
| `Segmented` | Filter group with optional counts |
| `EmptyState`, `ErrorState`, `LoadingBlock`, `Skeleton` | The three non-happy states |

`overlay.tsx` — `Dialog` (native `<dialog>`), `DialogActions`, `ConfirmDialog`,
`ToastProvider` / `useToast()`.
`domain.tsx` — Skyline vocabulary in one place: `Money`, `EventStatusBadge`,
`PaymentBadge`, `TransactionStatusBadge`, `MemberStatusBadge`, `TaskStatusBadge`,
`OrderStatusBadge`, `FactKindBadge`. Change a label or tone here and it changes everywhere.
`org-shell.tsx` — staff sidebar and mobile menu. Add a page to `ORG_NAV` to list it.
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
| `/shop`, `/join`, `/news` | `app/(public)/…` | products, announcements | order, join |
| `/login` | `app/login/page.tsx` | `auth/me` | login |
| `/org` | `app/org/page.tsx` | `dashboard` | — |
| `/org/events`, `/org/events/[id]` | `app/org/events/…` | events, transactions | events, status, registrations, tickets, transactions |
| `/org/check-in` | `app/org/check-in/page.tsx` | events | check-in |
| `/org/finance` | `app/org/finance/page.tsx` | summary, transactions, events | transactions |
| `/org/members` | `app/org/members/page.tsx` | members | members |
| `/org/tasks` | `app/org/tasks/page.tsx` | tasks, events | tasks |
| `/org/announcements` | `app/org/announcements/page.tsx` | announcements, members | announcements |
| `/org/merch` | `app/org/merch/page.tsx` | products, orders | products, orders |
| `/org/assistant` | `app/org/assistant/page.tsx` | assistant | assistant |

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
