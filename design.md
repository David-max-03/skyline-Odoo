# Skyline design

What Skyline should look and feel like, and the rules a screen is checked against.
For how the frontend is wired (files, props, API calls) see
[FRONTEND_HANDOFF.md](FRONTEND_HANDOFF.md). The token values live in
[`src/app/globals.css`](src/app/globals.css); if this file and the CSS disagree, the
CSS is what ships and this file needs correcting.

## 1. Who it is for

Student committee members doing club work between classes, often on a phone, sometimes
at a door with a queue. Students buying a ticket in under a minute. A treasurer who
has to explain the money to people who are not accountants.

So the interface is:

- **Calm.** White surfaces on a pale canvas, one dark navy for emphasis, one blue for
  action. Colour is spent on meaning, not decoration.
- **Direct.** Every screen answers a question in its first third: what is left, who is
  coming, what is overdue, is this ticket good.
- **Honest.** Figures are labelled as actual or estimated. Nothing says a payment was
  taken or an email was sent, because neither happens.

## 2. Principles

1. **One focal point per screen.** The most important number or action is the largest
   thing on it. If two things compete, one of them is wrong.
2. **Numbers arrive computed.** The UI shows what the server returns. It does not add,
   subtract or re-derive business figures.
3. **Status is never colour alone.** Every coloured state also has a word, and usually
   an icon.
4. **One primary action per view.** One filled blue button. Everything else is
   secondary or ghost. Destructive actions are quiet until confirmed.
5. **Every list has three other states.** Loading, empty and failed are designed, not
   left blank.
6. **Phone first for doing, desktop for reviewing.** Check-in, registration and the
   ticket must be effortless at 360px. Tables may be richer on a laptop.

## 3. Colour

Three layers: primitives → semantic → component. Components use only the Tailwind
classes generated from the semantic layer. No hex values in components.

| Role | Token | Class | Value | Use |
|---|---|---|---|---|
| Page | `--canvas` | `bg-canvas` | `#f8f9fb` | Behind everything |
| Card | `--surface` | `bg-surface` | `#ffffff` | Cards, dialogs, inputs |
| Inset | `--sunken` | `bg-sunken` | `#f2f4f7` | Table heads, wells, neutral badges |
| Divider | `--line` / `--line-strong` | `border-line` | `#e4e7ec` / `#d0d5dd` | Hairlines / control borders |
| Heading | `--ink` | `text-ink` | `#0b1220` | Titles, key figures |
| Body | `--body` | `text-body` | `#344054` | Paragraphs |
| Secondary | `--muted` | `text-muted` | `#475467` | Labels, descriptions |
| Tertiary | `--subtle` | `text-subtle` | `#667085` | Placeholders; the lightest text allowed |
| Action | `--brand` | `bg-brand`, `text-brand` | `#2563d9` | Primary buttons, links, progress |
| Action tint | `--brand-soft` | `bg-brand-soft` | `#eff5ff` | Selected, info badges |
| Emphasis | `--night` | `bg-night` | `#0b1220` | Sidebar, hero bands, ticket header |
| Highlight | `--accent` | `bg-accent`, `text-accent` | `#f5a524` | Active marker, "estimate" on dark. Never text on white |
| Good | `--ok` / `--ok-soft` | `text-ok`, `bg-ok-soft` | `#0f7a3d` / `#dcf5e6` | Paid, checked in, positive result |
| Caution | `--warn` / `--warn-soft` | `text-warn`, `bg-warn-soft` | `#7a4a00` / `#fdefd0` | Pending, renewal due, estimate |
| Problem | `--bad` / `--bad-soft` | `text-bad`, `bg-bad-soft` | `#b42318` / `#fde4e1` | Overdue, refused, loss, destructive |
| Chart series | `--chart-1`, `--chart-2` | via `style` | `#2a78d6`, `#eb6834` | Money in, money out. Validated for colour-blind separation |

Rules:

- Text on `surface` is at least 4.5:1. `subtle` (4.9:1) is the floor.
- On `night`, body text is `on-night` and secondary text is `on-night-muted` (9:1).
- Green and red on amounts mean direction of a *result* (profit or loss). A plain
  amount is `ink`.
- The amber accent appears at most a few times per screen.

## 4. Typography

| Family | Class | Use |
|---|---|---|
| Manrope | `font-display` | Headings and headline figures |
| Inter | `font-sans` | Everything else |
| System mono | `font-mono` | Ticket and order codes, member numbers |

| Role | Size / weight | Class |
|---|---|---|
| Hero figure | 44–52px, 800 | `text-[2.75rem] sm:text-[3.25rem] font-extrabold` |
| Page title (`h1`) | 24–27px, 700 | set by `PageHeader` |
| Stat figure | 28px, 700 | set by `Stat` |
| Card title (`h2`) | 15px, 600 | set by `CardHeader` |
| Body | 15px, 400, line-height 1.55 | default |
| Secondary | 13px | `text-[0.8125rem]` |
| Caption, table head | 12px, 600, uppercase for heads | `text-xs` |

Rules: figures use `.num` (tabular). Headings are sentence case. One `h1` per page;
card titles are `h2`; do not skip levels. Uppercase is for small labels only, with
letter-spacing.

## 5. Space, shape, elevation

- **Spacing** is the 4px scale. Card padding is 20px (`p-5`), 24px for hero blocks.
  Gaps between cards are 16–20px (`gap-4`, `gap-5`). Sections on a page are separated
  by 20–24px.
- **Width.** Staff content maxes at `max-w-6xl`; public at `max-w-5xl`; forms and the
  ticket at `max-w-md`. Page gutters are 16px on phones, 24–32px above.
- **Radius.** Controls 8px (`rounded-control`), cards 12px (`rounded-card`), pills full.
- **Elevation.** Cards carry a hairline border and `shadow-card`. Only things that float
  (dialogs, toasts, the ticket, the check-in verdict) use `shadow-raised`.

## 6. Components

All in `src/components`. Reuse before inventing.

| Need | Use | Notes |
|---|---|---|
| Action | `Button`, `LinkButton` | `primary` once per view; `secondary`; `ghost`; `danger`. Heights 36 / 40 / 48px |
| Container | `Card` + `CardHeader` | Title, optional description, optional action on the right |
| Page top | `PageHeader` | Title, one-sentence description, actions, optional back link |
| Figure | `Stat` | Icon tile, label, figure, one line of context |
| Proportion | `Meter` | Always beside the numbers it represents |
| Status | `Badge` and the badges in `domain.tsx` | Tone plus word; icon where it helps |
| Records | `Table stack` | Cards on phones; see FRONTEND_HANDOFF |
| Filter | `Segmented` | With counts |
| Input | `TextField`, `SelectField`, `TextAreaField`, `CheckboxField` | Label above, hint or error below |
| Message | `Notice` (inline), `FormError` (form), toast (result of an action) | |
| Overlay | `Dialog`, `ConfirmDialog` | Native `<dialog>`; confirm anything irreversible |
| Waiting | `TableSkeleton`, `StatSkeleton`, `Skeleton` | Shaped like what is coming |
| Nothing / failed | `EmptyState`, `ErrorState` | Say what to do next; errors offer retry |

### Signature patterns

- **Hero band.** A `bg-night` block holding the single most important figure, with up
  to three supporting figures beside it. Used on the dashboard (cash position) and the
  finance statement (what is left). One per page.
- **Statement.** Collected − Paid out = What is left, read left to right, with pending
  amounts in a separate row beneath. Pending is never mixed into the balance.
- **Actual / Estimate / Suggestion tags.** Any figure that depends on an assumption
  carries an amber "Estimate" tag. The assistant tags every fact.
- **Verdict panel.** Check-in results use a solid colour band with a large icon and
  title: green admitted, amber needs action, red refused.
- **Date tile.** Month over day beside an event title. Decorative; the full date is
  always in text next to it.

## 7. Layout and navigation

- **Desktop (≥1024px).** Fixed navy sidebar, 248px, grouped links; the active link has
  an amber marker. Content scrolls beside it.
- **Phone and tablet.** Navy top bar with the logo; fixed bottom tab bar with Home,
  Events, Check-in, Finance and More. More opens the full menu. Content has bottom
  padding so the bar never covers it.
- **Public pages.** White sticky header with four links, centred column, quiet footer
  with the committee sign-in link.
- **Grids** collapse to one column on phones. Nothing scrolls sideways at 360px except
  a table that has not opted into `stack`.

## 8. States

| State | Treatment |
|---|---|
| Loading | Skeleton in the shape of the content, with a screen-reader label. Reloads keep the old data and dim it |
| Empty | Icon in a soft ring, one-line title, one sentence on what to do, and the action if there is one |
| Error | Red-tinted icon, "This could not be loaded", the server's message, Try again |
| Success | A toast stating what happened in plain words, including what did not happen ("No email was sent") |
| Validation | Message under the field in red with an icon; a summary line above the form |
| Disabled | 55% opacity, not-allowed cursor; say why nearby if it is not obvious |

## 9. Motion

Short and functional: 150ms colour transitions on hover, a 220ms rise for dialogs and
toasts, a pop for the check-in verdict, a shimmer on skeletons. Buttons compress
slightly when pressed. Everything is disabled under `prefers-reduced-motion`.

## 10. Accessibility baseline

- Visible focus ring on every interactive element: blue on light, light on navy.
- Targets at least 40px tall, 44px for primary phone controls.
- Every input has a visible label; errors are tied to their field.
- Icon-only buttons have an `aria-label`. Decorative icons are `aria-hidden`.
- Dialogs trap focus and return it to the control that opened them.
- Live results (check-in verdict, toasts, assistant answers) are announced.
- Stacked tables keep table roles so rows and columns stay navigable.
- No emoji as icons. Icons are Lucide SVGs.

## 11. Voice

Plain words, sentence case, no exclamation marks. Buttons say what happens ("Mark
paid", "Cancel event"), not "OK" or "Submit". Money is always formatted with the
currency symbol. Dates are written out ("Sat, 31 Oct 2026, 7:00 pm").

## 12. Review checklist

A screen passes when all of these are true at 1360px and at 390px:

- [ ] One clear focal point; one primary button.
- [ ] No horizontal page scroll; no clipped or overlapping text.
- [ ] Headings, card padding and gaps match sections 4 and 5.
- [ ] Only semantic colour classes; status has words as well as colour.
- [ ] Loading, empty and error states exist and look intentional.
- [ ] Every control is reachable by keyboard with a visible focus ring.
- [ ] Every control has an accessible name.
- [ ] Wording follows section 11 and makes no false claims.
