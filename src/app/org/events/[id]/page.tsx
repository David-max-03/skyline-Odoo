"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Ban,
  Banknote,
  Calculator,
  Check,
  CircleAlert,
  Clock,
  ExternalLink,
  MapPin,
  Pencil,
  Plus,
  ScanLine,
  Target,
  Ticket as TicketIcon,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { EventStatusBadge, Money, PaymentBadge, TransactionStatusBadge, percent } from "@/components/domain";
import { EventForm } from "@/components/event-form";
import { ConfirmDialog, Dialog, DialogActions, useToast } from "@/components/overlay";
import { useCan } from "@/components/session";
import { TransactionForm } from "@/components/transaction-form";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  FormError,
  LinkButton,
  LoadingBlock,
  Meter,
  Notice,
  PageHeader,
  Segmented,
  SelectField,
  Stat,
  Table,
  Td,
  TextField,
  Th,
} from "@/components/ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import {
  CATEGORY_LABELS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type EventStatusChange,
  type EventDetailView,
  type EventView,
  type Ticket,
  type Transaction,
} from "@/lib/contracts";
import { formatDate, formatDateTime, formatShortDateTime, formatTime } from "@/lib/dates";

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const canManage = useCan("manageEvents");
  const canFinance = useCan("manageFinance");
  const canCollect = useCan("collectPayment");
  const canRefund = useCan("processRefunds");
  const canCancelEvent = useCan("cancelEvents");
  const detail = useApi<EventDetailView>(`/api/events/${id}`);
  // The ledger is for the president and the treasurer; the server refuses anyone else.
  const ledger = useApi<Transaction[]>(canFinance ? `/api/transactions?eventId=${id}` : null);

  const [tab, setTab] = useState<"people" | "money">("people");
  const [editing, setEditing] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [recording, setRecording] = useState(false);
  const [confirm, setConfirm] = useState<null | "cancel-event" | { cancelTicket: Ticket }>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reloadAll = () => {
    detail.reload();
    ledger.reload();
  };

  async function run(key: string, action: () => Promise<string | void>) {
    setBusy(key);
    try {
      const message = await action();
      if (message) toast.success(message);
      reloadAll();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  if (detail.error && !detail.data) {
    return (
      <>
        <PageHeader title="Event" back={{ href: "/org/events", label: "Events" }} />
        <Card>
          <ErrorState message={detail.error.message} onRetry={detail.reload} />
        </Card>
      </>
    );
  }
  if (!detail.data) {
    return (
      <>
        <PageHeader title="Event" back={{ href: "/org/events", label: "Events" }} />
        <Card>
          <LoadingBlock label="Loading event" rows={6} />
        </Card>
      </>
    );
  }

  const { event, tickets, breakEven, profitTarget } = detail.data;
  const f = event.finance;
  const valid = tickets.filter((t) => t.status === "valid");

  const setStatus = (status: "published" | "draft" | "cancelled") =>
    run(`status-${status}`, async () => {
      const change = await api<EventStatusChange>(`/api/events/${id}/status`, { method: "POST", body: { status } });
      setConfirm(null);
      if (status === "published") return "Published. Registration is open on the public site.";
      if (status === "draft") return "Moved back to draft. It is no longer public.";
      return change.refundsDueCents > 0
        ? "Event cancelled. Refunds owed are now listed under Money."
        : "Event cancelled. Unpaid ticket charges were removed.";
    });

  const ticketAction = (ticket: Ticket, action: "pay" | "cancel" | "undo_check_in", method = "cash") =>
    run(`${action}-${ticket.code}`, async () => {
      const result = await api<{ refundDueCents: number }>(`/api/tickets/${ticket.code}`, {
        method: "POST",
        body: { action, method },
      });
      setConfirm(null);
      if (action === "pay") return `Payment recorded for ${ticket.attendeeName}.`;
      if (action === "undo_check_in") return `Check-in undone for ${ticket.attendeeName}.`;
      return result.refundDueCents > 0
        ? `Ticket cancelled. A refund is now owed to ${ticket.attendeeName}.`
        : `Ticket cancelled for ${ticket.attendeeName}. The seat is free again.`;
    });

  return (
    <>
      <PageHeader
        back={{ href: "/org/events", label: "Events" }}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {event.title}
            <EventStatusBadge status={event.status} phase={event.phase} />
          </span>
        }
        description={
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="size-4" aria-hidden />
              {formatDateTime(event.startsAt)} – {formatTime(event.endsAt)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-4" aria-hidden />
              {event.venue}
            </span>
          </span>
        }
        actions={
          <>
            {event.status === "published" && (
              <>
                <LinkButton href={`/events/${event.id}`} target="_blank" variant="ghost" icon={ExternalLink}>
                  Public page
                </LinkButton>
              </>
            )}
            {canCancelEvent && event.status !== "cancelled" && (
              <Button variant="ghost" icon={Ban} className="!text-bad hover:!bg-bad-soft" onClick={() => setConfirm("cancel-event")}>
                Cancel event
              </Button>
            )}
            {canManage && event.status === "published" && valid.length === 0 && (
              <Button variant="secondary" loading={busy === "status-draft"} onClick={() => setStatus("draft")}>
                Unpublish
              </Button>
            )}
            {canManage && event.status !== "cancelled" && (
              <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {/* One primary action per state: publish a draft, or run the door for a live event. */}
            {canManage && event.status === "draft" && (
              <Button icon={Check} className="max-sm:order-first max-sm:w-full" loading={busy === "status-published"} onClick={() => setStatus("published")}>
                Publish
              </Button>
            )}
            {event.status === "published" && (
              <LinkButton href={`/org/check-in?event=${event.id}`} icon={ScanLine} className="max-sm:order-first max-sm:w-full">
                Check-in
              </LinkButton>
            )}
          </>
        }
      />

      {event.status === "draft" && (
        <Notice tone="brand" icon={CircleAlert} title="This event is a draft" className="mb-5">
          Only the committee can see it. Publish it to list it on the public site and open registration.
        </Notice>
      )}
      {event.status === "cancelled" && (
        <Notice tone="bad" icon={Ban} title="This event was cancelled" className="mb-5">
          Tickets can no longer be used. Any refunds owed appear under Money as entries to pay.
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Stat
          label="Registered"
          icon={Users}
          tone="brand"
          value={
            <>
              {event.stats.registered}
              <span className="text-base font-medium text-muted"> / {event.capacity}</span>
            </>
          }
          detail={
            <>
              <Meter
                value={event.stats.registered}
                max={event.capacity}
                label="Seats taken"
                tone={event.stats.remaining === 0 ? "bad" : "brand"}
              />
              <p className="mt-2">{event.stats.remaining === 0 ? "Full" : `${event.stats.remaining} seats left`}</p>
            </>
          }
        />
        <Stat
          label="Tickets paid"
          icon={TicketIcon}
          tone="ok"
          value={event.stats.paid}
          detail={`${event.stats.pending} unpaid · ${event.stats.free} free`}
        />
        <Stat
          label="Checked in"
          icon={ScanLine}
          tone="brand"
          value={event.stats.checkedIn}
          detail={event.phase === "upcoming" ? "Event has not started yet" : `Turnout ${percent(event.stats.attendanceRate)}`}
        />
        {f && (
          <Stat
            label="Result so far"
            icon={Wallet}
            tone={f.netCents < 0 ? "bad" : "ok"}
            value={<Money cents={f.netCents} signed />}
            detail={
              <>
                <Money cents={f.incomeSettledCents} /> collected − <Money cents={f.expenseSettledCents} /> paid
              </>
            }
          />
        )}
      </div>

      {breakEven && (
      <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Calculator className="size-4 text-muted" aria-hidden />
                Break-even
                <Badge tone="warn">Estimate</Badge>
              </span>
            }
            description="Counts every linked cost, paid or owed, and tickets registered whether paid or not."
          />
          <div className="space-y-3 p-5 text-sm">
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
              <dt className="text-muted">Costs recorded</dt>
              <dd className="text-right"><Money cents={breakEven.costCents} /></dd>
              <dt className="text-muted">Other income (sponsors, donations)</dt>
              <dd className="text-right"><Money cents={-breakEven.otherIncomeCents} /></dd>
              <dt className="font-medium text-ink">Tickets must cover</dt>
              <dd className="text-right font-semibold text-ink"><Money cents={breakEven.toCoverCents} /></dd>
              <dt className="text-muted">Ticket income so far</dt>
              <dd className="text-right"><Money cents={breakEven.ticketIncomeCents} /></dd>
            </dl>
            {breakEven.costCents === 0 ? (
              <Notice tone="neutral">Record this event&rsquo;s costs under Money to get a break-even figure.</Notice>
            ) : breakEven.alreadyCovered ? (
              <Notice tone="ok" icon={Check}>Recorded income already covers the recorded costs.</Notice>
            ) : breakEven.scenarios.length === 0 ? (
              <Notice tone="warn" icon={CircleAlert}>
                Entry is free, so tickets cannot cover the <Money cents={breakEven.toCoverCents} /> shortfall. It needs a sponsor or the club budget.
              </Notice>
            ) : (
              <ul className="divide-y divide-line rounded-control border border-line">
                {breakEven.scenarios.map((s) => (
                  <li key={s.label} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <span>
                      <span className="block font-medium text-ink">
                        <span className="num">{s.moreTicketsNeeded}</span> more {s.moreTicketsNeeded === 1 ? "ticket" : "tickets"}
                      </span>
                      <span className="text-[0.8125rem] text-muted">
                        {s.label.toLowerCase()} of <Money cents={s.priceCents} /> · {s.ticketsNeeded} in total
                      </span>
                    </span>
                    {s.achievable ? <Badge tone="ok">Fits in {event.stats.remaining} seats left</Badge> : <Badge tone="bad">More than seats left</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Target className="size-4 text-muted" aria-hidden />
                Profit target
              </span>
            }
            description={profitTarget ? undefined : "Set a target on the event to track the gap."}
          />
          {profitTarget ? (
            <div className="space-y-3 p-5 text-sm">
              <dl className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5">
                <dt className="text-muted">Target</dt>
                <dd className="text-right font-semibold text-ink"><Money cents={profitTarget.targetCents} /></dd>
                <dt className="flex items-center gap-2 text-muted">Result today <Badge tone="ok">Actual</Badge></dt>
                <dd className="text-right"><Money cents={profitTarget.actualNetCents} signed colored /></dd>
                <dt className="flex items-center gap-2 text-muted">If pending items settle <Badge tone="warn">Estimate</Badge></dt>
                <dd className="text-right"><Money cents={profitTarget.projectedNetCents} signed colored /></dd>
              </dl>
              {profitTarget.gapProjectedCents === 0 ? (
                <Notice tone="ok" icon={Check}>
                  {profitTarget.gapActualCents === 0
                    ? "The target has been reached on money actually collected."
                    : "On track: the target is met once pending payments and costs settle."}
                </Notice>
              ) : (
                <Notice tone="warn" icon={CircleAlert}>
                  <Money cents={profitTarget.gapProjectedCents} className="font-semibold" /> of new revenue is still needed
                  {profitTarget.ticketsToCloseGap !== null && (
                    <>
                      , about <span className="num font-semibold">{profitTarget.ticketsToCloseGap}</span> more full-price tickets ({profitTarget.seatsRemaining} seats left)
                    </>
                  )}
                  .
                </Notice>
              )}
            </div>
          ) : (
            <EmptyState
              icon={Target}
              title="No profit target"
              action={
                canManage && event.status !== "cancelled" ? (
                  <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                    Set a target
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>
      </div>
      )}

      <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-3">
        {f ? (
          <Segmented
            label="Event records"
            value={tab}
            onChange={setTab}
            options={[
              { value: "people", label: "Registrations", count: valid.length },
              { value: "money", label: "Money", count: ledger.data?.length },
            ]}
          />
        ) : (
          <h2 className="text-[0.9375rem] font-semibold">
            Registrations <span className="num font-medium text-muted">({valid.length})</span>
          </h2>
        )}
        {tab === "people" || !f
          ? event.status === "published" &&
            event.phase !== "past" && (
              <Button variant="secondary" icon={UserPlus} onClick={() => setRegistering(true)}>
                Register someone
              </Button>
            )
          : event.status !== "draft" && (
              <Button variant="secondary" icon={Plus} onClick={() => setRecording(true)}>
                {canFinance ? "Record income or expense" : "File expense claim"}
              </Button>
            )}
      </div>

      {tab === "people" || !f ? (
        <Card>
          {tickets.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No registrations yet"
              description={event.status === "draft" ? "Publish the event to open registration." : "Share the public page, or register someone at the desk."}
            />
          ) : (
            <Table stack>
              <thead>
                <tr>
                  <Th>Attendee</Th>
                  <Th>Ticket</Th>
                  <Th align="right">Price</Th>
                  <Th>Payment</Th>
                  <Th>Entry</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id} className={t.status === "cancelled" ? "text-subtle" : "hover:bg-sunken/50"}>
                    <Td layout="lead">
                      <div className="font-medium text-ink">{t.attendeeName}</div>
                      <div className="text-[0.8125rem] text-muted">{t.attendeeEmail}</div>
                    </Td>
                    <Td label="Ticket">
                      <div>
                      <Link href={`/t/${t.code}`} target="_blank" className="font-mono text-[0.8125rem] text-brand hover:underline">
                        {t.code}
                      </Link>
                      {t.memberNo && <div className="text-xs text-muted">Member {t.memberNo}</div>}
                      </div>
                    </Td>
                    <Td label="Price" align="right">{t.priceCents === 0 ? "Free" : <Money cents={t.priceCents} />}</Td>
                    <Td label="Payment">{t.status === "cancelled" ? <Badge tone="bad">Cancelled</Badge> : <PaymentBadge status={t.paymentStatus} />}</Td>
                    <Td label="Entry">
                      {t.checkedInAt ? (
                        <span className="text-[0.8125rem]">
                          <Badge tone="ok" icon={Check}>In</Badge> <span className="text-muted">{formatShortDateTime(t.checkedInAt)}</span>
                        </span>
                      ) : (
                        <span className="text-subtle">Not yet</span>
                      )}
                    </Td>
                    <Td layout="actions">
                      {t.status === "valid" && event.status === "published" && (
                        <div className="flex justify-end gap-1">
                          {canCollect && t.paymentStatus === "pending" && (
                            <Button size="sm" variant="secondary" icon={Banknote} loading={busy === `pay-${t.code}`} onClick={() => ticketAction(t, "pay")}>
                              Mark paid
                            </Button>
                          )}
                          {canManage && t.checkedInAt && (
                            <Button size="sm" variant="ghost" loading={busy === `undo_check_in-${t.code}`} onClick={() => ticketAction(t, "undo_check_in")}>
                              Undo entry
                            </Button>
                          )}
                          {/* Cancelling a paid ticket records a refund, which only the president may do. */}
                          {(t.paymentStatus === "paid" ? canRefund : canManage) && !t.checkedInAt && (
                            <Button size="sm" variant="ghost" onClick={() => setConfirm({ cancelTicket: t })}>
                              Cancel
                            </Button>
                          )}
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      ) : (
        <Card>
          <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
            {[
              { label: "Collected", cents: f.incomeSettledCents },
              { label: "To collect", cents: f.incomePendingCents },
              { label: "Paid out", cents: f.expenseSettledCents },
              { label: "Owed", cents: f.expensePendingCents },
            ].map((cell) => (
              <div key={cell.label} className="bg-surface px-5 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">{cell.label}</p>
                <p className="mt-0.5 font-display text-lg font-bold text-ink"><Money cents={cell.cents} /></p>
              </div>
            ))}
          </div>
          {ledger.error && !ledger.data ? (
            <ErrorState message={ledger.error.message} onRetry={ledger.reload} />
          ) : !ledger.data ? (
            <LoadingBlock label="Loading entries" />
          ) : ledger.data.length === 0 ? (
            <EmptyState icon={Wallet} title="No money recorded for this event" description="Ticket charges appear here automatically. Add venue, catering and other costs yourself." />
          ) : (
            <Table stack>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Entry</Th>
                  <Th>Category</Th>
                  <Th>Status</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {ledger.data.map((t) => (
                  <tr key={t.id} className="hover:bg-sunken/50">
                    <Td label="Date" className="whitespace-nowrap text-muted">{formatDate(t.occurredOn)}</Td>
                    <Td layout="lead" className="max-sm:order-first">
                      <div className="font-medium text-ink">{t.description}</div>
                      {t.counterparty && <div className="text-[0.8125rem] text-muted">{t.counterparty}</div>}
                    </Td>
                    <Td label="Category" className="text-muted">{CATEGORY_LABELS[t.category]}</Td>
                    <Td label="Status"><TransactionStatusBadge type={t.type} status={t.status} /></Td>
                    <Td label="Amount" align="right">
                      <Money cents={t.type === "income" ? t.amountCents : -t.amountCents} signed className="font-medium text-ink" />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="border-t border-line px-5 py-3 text-[0.8125rem] text-muted">
            Settle, edit or void entries on the <Link href={`/org/finance?eventId=${event.id}`} className="font-medium text-brand hover:underline">Finance page</Link>.
          </p>
        </Card>
      )}

      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit event">
        <EventForm
          key={event.updatedAt}
          event={event}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast.success("Event updated.");
            reloadAll();
          }}
        />
      </Dialog>

      <Dialog open={registering} onClose={() => setRegistering(false)} title="Register someone" description={`Adds a ticket for ${event.title}.`}>
        {registering && (
          <DeskRegistration
            event={event}
            canCollect={canCollect}
            onCancel={() => setRegistering(false)}
            onDone={(ticket) => {
              setRegistering(false);
              toast.success(`${ticket.attendeeName} is registered. Ticket ${ticket.code}.`);
              reloadAll();
            }}
          />
        )}
      </Dialog>

      <Dialog open={recording} onClose={() => setRecording(false)} title={canFinance ? "Record income or expense" : "File an expense claim"} description={`Linked to ${event.title}.`}>
        {recording && (
          <TransactionForm
            events={[]}
            lockedEventId={event.id}
            claimOnly={!canFinance}
            onCancel={() => setRecording(false)}
            onSaved={() => {
              setRecording(false);
              toast.success(canFinance ? "Entry recorded." : "Claim filed for the treasurer.");
              reloadAll();
            }}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={confirm === "cancel-event"}
        onClose={() => setConfirm(null)}
        onConfirm={() => setStatus("cancelled")}
        title={`Cancel ${event.title}?`}
        confirmLabel="Cancel the event"
        danger
        loading={busy === "status-cancelled"}
      >
        <p>This cannot be undone. Registration closes and tickets stop working at the door.</p>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li><strong>{event.stats.pending}</strong> unpaid ticket {event.stats.pending === 1 ? "charge is" : "charges are"} removed.</li>
          <li><strong>{event.stats.paid}</strong> paid {event.stats.paid === 1 ? "ticket becomes a refund" : "tickets become refunds"} for the treasurer to pay.</li>
        </ul>
        <p className="mt-3 text-muted">Skyline does not notify attendees. Post an announcement to tell them.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={typeof confirm === "object" && confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => typeof confirm === "object" && confirm && ticketAction(confirm.cancelTicket, "cancel")}
        title="Cancel this ticket?"
        confirmLabel="Cancel ticket"
        danger
        loading={busy?.startsWith("cancel-") ?? false}
      >
        {typeof confirm === "object" && confirm && (
          <p>
            {confirm.cancelTicket.attendeeName}&rsquo;s ticket will stop working and the seat becomes available again.
            {confirm.cancelTicket.paymentStatus === "paid" && " Because it was paid, a refund will be listed for the treasurer."}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

function DeskRegistration({
  event,
  canCollect,
  onDone,
  onCancel,
}: {
  event: EventView;
  canCollect: boolean;
  onDone: (ticket: Ticket) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState({ name: "", email: "", studentId: "", memberNo: "", payNow: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const ticket = await api<Ticket>(`/api/events/${event.id}/registrations`, {
        method: "POST",
        body: { ...values, studentId: values.studentId || null, memberNo: values.memberNo || null, payNow: values.payNow || null },
      });
      onDone(ticket);
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <FormError message={formError} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Full name" value={values.name} onChange={set("name")} error={errors.name} required autoFocus />
        <TextField label="Email" type="email" value={values.email} onChange={set("email")} error={errors.email} required />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Student ID" value={values.studentId} onChange={set("studentId")} error={errors.studentId} optional />
        <TextField
          label="Member number"
          value={values.memberNo}
          onChange={set("memberNo")}
          error={errors.memberNo}
          optional
          placeholder="SKY-M-0001"
          hint={event.memberPriceCents !== event.priceCents ? "Must match the email to get the member price." : undefined}
        />
      </div>
      {event.priceCents > 0 && !canCollect && (
        <p className="text-sm text-muted">The ticket is added unpaid. The treasurer or the president records the payment.</p>
      )}
      {event.priceCents > 0 && canCollect && (
        <SelectField label="Payment" value={values.payNow} onChange={set("payNow")} hint="Choose a method only if you have the money in hand.">
          <option value="">Not paid yet</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              Paid now by {PAYMENT_METHOD_LABELS[m].toLowerCase()}
            </option>
          ))}
        </SelectField>
      )}
      <DialogActions>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          Register
        </Button>
      </DialogActions>
    </form>
  );
}
