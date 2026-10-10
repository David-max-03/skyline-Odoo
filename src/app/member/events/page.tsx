"use client";

import Link from "next/link";
import { CalendarDays, Check, MapPin, QrCode, Ticket } from "lucide-react";
import { useState } from "react";
import { DateBlock, Money, PaymentBadge } from "@/components/domain";
import { ConfirmDialog, useToast } from "@/components/overlay";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LinkButton, LoadingBlock, Notice, PageHeader } from "@/components/ui";
import { api, errorMessage, useApi } from "@/lib/api-client";
import type { MemberDetail, PaymentInstructions, PublicEvent } from "@/lib/contracts";
import { formatDateTime, formatShortDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

type MyTicket = MemberDetail["tickets"][number];

export default function MemberEventsPage() {
  const toast = useToast();
  const me = useApi<MemberDetail>("/api/me");
  const events = useApi<PublicEvent[]>("/api/public/events");
  const pay = useApi<PaymentInstructions>("/api/public/membership");
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<MyTicket | null>(null);
  const [now] = useState(() => Date.now());

  const tickets = me.data?.tickets ?? [];
  const live = tickets.filter((t) => t.status === "valid");
  const upcoming = live.filter((t) => Date.parse(t.startsAt) > now - 6 * 3_600_000);
  const history = tickets.filter((t) => !upcoming.includes(t));
  const heldEventIds = new Set(live.map((t) => t.eventId));
  const memberPrice = me.data?.status === "active" || me.data?.status === "expiring";
  const owed = upcoming.filter((t) => t.paymentStatus === "pending");

  async function register(event: PublicEvent) {
    setBusy(event.id);
    try {
      const ticket = await api<{ code: string; priceCents: number; paymentStatus: string }>(`/api/me/events/${event.id}/register`, { method: "POST" });
      toast.success(
        ticket.paymentStatus === "pending"
          ? `Seat reserved for ${event.title}. Pay ${formatMoney(ticket.priceCents)} to the committee to confirm it.`
          : `You are registered for ${event.title}.`,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
      me.reload();
      events.reload();
    }
  }

  async function cancel() {
    if (!cancelling) return;
    setBusy(cancelling.code);
    try {
      await api(`/api/me/tickets/${cancelling.code}/cancel`, { method: "POST" });
      toast.success(`Your registration for ${cancelling.eventTitle} is cancelled.`);
      setCancelling(null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
      me.reload();
      events.reload();
    }
  }

  if (me.error && !me.data) {
    return (
      <Card>
        <ErrorState message={me.error.message} onRetry={me.reload} />
      </Card>
    );
  }

  return (
    <>
      <PageHeader title="Events and tickets" description="Register with one tap. Your ticket and its QR code stay here for the door." />

      {owed.length > 0 && (
        <Notice tone="warn" title={`${owed.length === 1 ? "One ticket is" : `${owed.length} tickets are`} not paid yet`} className="mb-5">
          Your seat is held. Pay a committee member{pay.data?.upi ? <>, or send it by UPI to <span className="font-mono">{pay.data.upi.vpa}</span> and show them the confirmation</> : null}. The ticket
          turns to Paid only when the committee records the payment; nothing is taken on this site.
        </Notice>
      )}

      <Card className="mb-6">
        <CardHeader title="My tickets" />
        {!me.data ? (
          <LoadingBlock label="Loading your tickets" rows={2} />
        ) : upcoming.length === 0 ? (
          <EmptyState icon={Ticket} title="No upcoming tickets" description="Register for an event below and your ticket appears here." />
        ) : (
          <ul className="divide-y divide-line">
            {upcoming.map((t) => (
              <li key={t.code} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{t.eventTitle}</p>
                  <p className="text-[0.8125rem] text-muted">
                    {formatDateTime(t.startsAt)} · <span className="font-mono">{t.code}</span>
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <PaymentBadge status={t.paymentStatus} />
                    {t.priceCents > 0 && <Money cents={t.priceCents} className="text-sm text-muted" />}
                    {t.checkedInAt && (
                      <Badge tone="ok" icon={Check}>
                        Checked in
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <LinkButton href={`/t/${t.code}`} icon={QrCode}>
                    Show QR code
                  </LinkButton>
                  {!t.checkedInAt && t.paymentStatus !== "paid" && (
                    <Button variant="secondary" onClick={() => setCancelling(t)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <h2 className="mb-3 text-lg font-bold">Open for registration</h2>
      {events.error && !events.data ? (
        <Card>
          <ErrorState message={events.error.message} onRetry={events.reload} />
        </Card>
      ) : !events.data ? (
        <Card>
          <LoadingBlock label="Loading events" />
        </Card>
      ) : events.data.length === 0 ? (
        <Card>
          <EmptyState icon={CalendarDays} title="No events are open right now" description="New events are announced on the news board." />
        </Card>
      ) : (
        <ul className="space-y-3">
          {events.data.map((event) => {
            const mine = heldEventIds.has(event.id);
            const price = memberPrice ? event.memberPriceCents : event.priceCents;
            return (
              <li key={event.id} className="flex flex-col gap-4 rounded-card border border-line bg-surface p-5 shadow-card sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-4">
                  <DateBlock iso={event.startsAt} />
                  <div className="min-w-0">
                    <Link href={`/events/${event.id}`} className="text-[0.9375rem] font-semibold text-ink hover:text-brand hover:underline">
                      {event.title}
                    </Link>
                    <p className="text-[0.8125rem] text-muted">{formatDateTime(event.startsAt)}</p>
                    <p className="flex items-center gap-1 text-[0.8125rem] text-muted">
                      <MapPin className="size-3.5 shrink-0" aria-hidden />
                      {event.venue}
                    </p>
                    <p className="mt-1 text-[0.8125rem] text-muted">
                      {event.closedReason === "sold_out" ? "Sold out" : `${event.remaining} of ${event.capacity} seats left`}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center justify-between gap-4 sm:flex-col sm:items-end sm:gap-2">
                  <p className="text-right">
                    <span className="font-display text-lg font-bold text-ink">{price === 0 ? "Free" : <Money cents={price} />}</span>
                    {memberPrice && event.memberPriceCents < event.priceCents && <span className="block text-xs text-ok">Member price</span>}
                  </p>
                  {mine ? (
                    <Badge tone="ok" icon={Check}>
                      You are going
                    </Badge>
                  ) : (
                    <Button disabled={!event.registrationOpen} loading={busy === event.id} onClick={() => register(event)}>
                      {event.closedReason === "sold_out" ? "Sold out" : price === 0 ? "Register" : "Reserve my seat"}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {history.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="Past and cancelled" />
          <ul className="divide-y divide-line text-sm">
            {history.map((t) => (
              <li key={t.code} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                <span className="min-w-0">
                  <span className="text-ink">{t.eventTitle}</span> <span className="text-muted">{formatShortDateTime(t.startsAt)}</span>
                </span>
                <span className="flex items-center gap-2">
                  {t.status === "cancelled" ? <Badge tone="bad">Cancelled</Badge> : t.checkedInAt ? <Badge tone="ok">Attended</Badge> : <Badge>Did not attend</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        onConfirm={cancel}
        title="Cancel this registration?"
        confirmLabel="Cancel registration"
        danger
        loading={busy === cancelling?.code}
      >
        <p>Your seat for “{cancelling?.eventTitle}” is released for someone else. You can register again if seats remain.</p>
      </ConfirmDialog>
    </>
  );
}
