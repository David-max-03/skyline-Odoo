"use client";

import Link from "next/link";
import { CalendarDays, Check, Shirt, Ticket } from "lucide-react";
import { useState } from "react";
import { MemberStatusBadge, Money, OrderStatusBadge, PaymentBadge } from "@/components/domain";
import { useSession } from "@/components/session";
import { Badge, Card, CardHeader, EmptyState, ErrorState, LinkButton, LoadingBlock, Notice } from "@/components/ui";
import { useApi } from "@/lib/api-client";
import type { MemberDetail } from "@/lib/contracts";
import { formatDate, formatShortDateTime } from "@/lib/dates";

export default function MemberHomePage() {
  const user = useSession();
  const { data: me, error, reload } = useApi<MemberDetail>("/api/me");
  const [now] = useState(() => Date.now());

  if (error && !me) {
    return (
      <Card>
        <ErrorState message={error.message} onRetry={reload} />
      </Card>
    );
  }
  if (!me) {
    return (
      <Card>
        <LoadingBlock label="Loading your membership" />
      </Card>
    );
  }

  const upcoming = me.tickets.filter((t) => t.status === "valid" && Date.parse(t.startsAt) > now - 6 * 3_600_000);
  const openOrders = me.orders.filter((o) => o.status === "placed");

  return (
    <div className="space-y-6">
      <section className="rounded-card bg-night px-6 py-7 sm:px-8">
        <p className="text-sm font-semibold uppercase tracking-wider text-accent">Member</p>
        <h1 className="mt-2 text-2xl font-extrabold !text-white sm:text-3xl">Hello, {user.name.split(" ")[0]}</h1>
        <dl className="mt-5 flex flex-wrap gap-x-10 gap-y-4 text-sm">
          <div>
            <dt className="text-on-night-muted">Member ID</dt>
            <dd className="font-mono text-lg font-bold text-on-night">{me.memberNo}</dd>
          </div>
          <div>
            <dt className="text-on-night-muted">Membership</dt>
            <dd className="mt-0.5">
              <MemberStatusBadge status={me.status} />
            </dd>
          </div>
          <div>
            <dt className="text-on-night-muted">Paid until</dt>
            <dd className="text-lg font-semibold text-on-night">{me.paidUntilOn ? formatDate(me.paidUntilOn) : "Not paid"}</dd>
          </div>
        </dl>
      </section>

      {me.status === "expiring" && (
        <Notice tone="warn" title={`Your membership ends in ${me.daysToExpiry} days`}>
          Pay next year&rsquo;s dues to the treasurer to keep member prices.
        </Notice>
      )}
      {(me.status === "lapsed" || me.status === "unpaid") && (
        <Notice tone="bad" title={me.status === "lapsed" ? "Your membership has lapsed" : "Your dues have not been collected"}>
          Member prices are paused until the treasurer records your dues.
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Your upcoming events" />
          {upcoming.length === 0 ? (
            <EmptyState icon={CalendarDays} title="No tickets yet" description="Register for an event and your ticket shows up here." />
          ) : (
            <ul className="divide-y divide-line">
              {upcoming.map((t) => (
                <li key={t.code}>
                  <Link href={`/t/${t.code}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 transition-colors hover:bg-sunken/60">
                    <span className="min-w-0">
                      <span className="block font-medium text-ink">{t.eventTitle}</span>
                      <span className="block text-[0.8125rem] text-muted">{formatShortDateTime(t.startsAt)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <PaymentBadge status={t.paymentStatus} />
                      {t.checkedInAt && (
                        <Badge tone="ok" icon={Check}>
                          Checked in
                        </Badge>
                      )}
                      <Ticket className="size-4 text-brand" aria-hidden />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line px-5 py-3.5">
            <LinkButton href="/member/events" variant="secondary" size="sm" icon={CalendarDays}>
              Browse events
            </LinkButton>
          </div>
        </Card>

        <Card>
          <CardHeader title="Orders to collect" />
          {openOrders.length === 0 ? (
            <EmptyState icon={Shirt} title="Nothing waiting" description="Merchandise you order shows here until you collect it." />
          ) : (
            <ul className="divide-y divide-line">
              {openOrders.map((o) => (
                <li key={o.code} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 text-sm">
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">
                      {o.quantity} × {o.productName} ({o.size})
                    </span>
                    <span className="block font-mono text-[0.8125rem] text-muted">{o.code}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Money cents={o.totalCents} />
                    <Badge tone={o.paymentStatus === "paid" ? "ok" : "warn"}>{o.paymentStatus === "paid" ? "Paid" : "Unpaid"}</Badge>
                    <OrderStatusBadge status={o.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line px-5 py-3.5">
            <LinkButton href="/member/orders" variant="secondary" size="sm" icon={Shirt}>
              All my orders
            </LinkButton>
          </div>
        </Card>
      </div>
    </div>
  );
}
