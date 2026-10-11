"use client";

import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Info,
  ListChecks,
  MapPin,
  ScanLine,
  Ticket,
  UserCheck,
  Users,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { CashflowChart } from "@/components/charts";
import { EventStatusBadge, Money, percent } from "@/components/domain";
import { useCan, useSession } from "@/components/session";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LinkButton,
  Meter,
  PageHeader,
  Skeleton,
  Stat,
  StatSkeleton,
  Table,
  Td,
  Th,
  cn,
} from "@/components/ui";
import { useApi } from "@/lib/api-client";
import type { DashboardView, FinanceTotals } from "@/lib/contracts";
import { formatDateTime, formatShortDateTime } from "@/lib/dates";

/** "in 6 days", "tomorrow", "in 3 hours": wording only, the date itself is shown beside it. */
function timeUntil(iso: string, from: number): string {
  const hours = Math.round((Date.parse(iso) - from) / 3_600_000);
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

export default function DashboardPage() {
  const user = useSession();
  const canCheckIn = useCan("checkIn");
  const { data, error, loading, reload } = useApi<DashboardView>("/api/dashboard");
  const [openedAt] = useState(() => Date.now());
  const today = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long" }).format(openedAt);

  return (
    <>
      <PageHeader
        title={`Hello, ${user.name.split(" ")[0]}`}
        description={`${today}. Every figure below is read from the club's records.`}
        actions={
          // On phones these two are already in the tab bar.
          <div className="hidden gap-2 lg:flex">
            {canCheckIn && (
              <LinkButton href="/org/check-in" variant="secondary" icon={ScanLine}>
                Check-in
              </LinkButton>
            )}
            <LinkButton href="/org/events" icon={CalendarDays}>
              Events
            </LinkButton>
          </div>
        }
      />

      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : !data ? (
        <div className="space-y-5">
          <Skeleton className="h-44 !rounded-card" />
          <StatSkeleton />
          <Skeleton className="h-72 !rounded-card" />
        </div>
      ) : (
        <div className={cn("space-y-5 transition-opacity duration-200", loading && "opacity-70")} aria-busy={loading}>
          {data.finance && <CashPosition finance={data.finance} />}

          <div className={cn("grid grid-cols-2 gap-3 sm:gap-4", data.members ? "xl:grid-cols-4" : "xl:grid-cols-3")}>
            {data.members && (
              <Stat
                label="Active members"
                icon={Users}
                tone="ok"
                value={
                  <>
                    {data.members.active}
                    <span className="text-base font-medium text-muted"> / {data.members.total}</span>
                  </>
                }
                detail={`${data.members.expiring} due to renew · ${data.members.unpaid} with unpaid dues`}
              />
            )}
            <Stat
              label="Registrations"
              icon={Ticket}
              tone="brand"
              value={data.tickets.registered}
              detail={`${data.tickets.paid} paid · ${data.tickets.pending} unpaid · ${data.tickets.free} free`}
            />
            <Stat
              label="Turnout"
              icon={UserCheck}
              tone="brand"
              value={percent(data.tickets.attendanceRate)}
              detail={`${data.tickets.checkedIn} checked in across events that have started`}
            />
            {data.tasks && (
              <Stat
                label="Open tasks"
                icon={ListChecks}
                tone={data.tasks.overdue > 0 ? "bad" : "ok"}
                value={data.tasks.open}
                detail={data.tasks.overdue > 0 ? `${data.tasks.overdue} overdue · ${data.tasks.done} done` : `None overdue · ${data.tasks.done} done`}
              />
            )}
          </div>

          <div className="grid gap-5 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    Needs attention
                    {data.alerts.length > 0 && <Badge tone="warn">{data.alerts.length}</Badge>}
                  </span>
                }
                description="Most urgent first. Each one opens the page where you deal with it."
              />
              {data.alerts.length === 0 ? (
                <EmptyState icon={CircleCheck} title="Nothing is waiting on you" description="No overdue tasks, unpaid claims or expiring memberships." />
              ) : (
                <ul>
                  {data.alerts.map((alert) => (
                    <li key={alert.kind} className="border-b border-line last:border-0">
                      <Link href={alert.href} className="group flex items-start gap-3.5 px-5 py-4 transition-colors hover:bg-sunken/60">
                        <span
                          className={cn(
                            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
                            alert.severity === "warning" ? "bg-warn-soft text-warn" : "bg-brand-soft text-brand-deep",
                          )}
                        >
                          {alert.severity === "warning" ? <CircleAlert className="size-4" aria-hidden /> : <Info className="size-4" aria-hidden />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-ink group-hover:text-brand">{alert.title}</span>
                          <span className="mt-0.5 block text-[0.8125rem] leading-snug text-muted">{alert.detail}</span>
                        </span>
                        <ChevronRight className="mt-2 size-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-brand" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="flex flex-col lg:col-span-2">
              <CardHeader title="Next event" />
              {data.events.next ? (
                <div className="flex flex-1 flex-col p-5">
                  <p className="text-[0.8125rem] font-semibold uppercase tracking-wide text-brand">{timeUntil(data.events.next.startsAt, openedAt)}</p>
                  <p className="mt-1 font-display text-xl font-bold leading-snug text-ink">{data.events.next.title}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
                    <CalendarDays className="size-4 shrink-0" aria-hidden />
                    {formatDateTime(data.events.next.startsAt)}
                  </p>
                  <div className="mt-5 rounded-control bg-sunken p-4">
                    <div className="mb-2 flex items-baseline justify-between gap-3">
                      <span className="font-display text-lg font-bold text-ink">
                        <span className="num">{data.events.next.registered}</span>
                        <span className="text-sm font-medium text-muted"> of {data.events.next.capacity} seats</span>
                      </span>
                      <span className="num text-sm font-semibold text-ink">{percent(data.events.next.registered / data.events.next.capacity)}</span>
                    </div>
                    <Meter value={data.events.next.registered} max={data.events.next.capacity} label="Seats taken" size="md" />
                  </div>
                  <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                    {[
                      { label: "Upcoming", value: data.events.upcoming },
                      { label: "Finished", value: data.events.past },
                      { label: "Drafts", value: data.events.draft },
                    ].map((item) => (
                      <div key={item.label} className="rounded-control border border-line px-2 py-2.5">
                        <dd className="num font-display text-lg font-bold text-ink">{item.value}</dd>
                        <dt className="text-xs text-muted">{item.label}</dt>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-auto flex flex-wrap gap-2 pt-5">
                    <LinkButton href={`/org/events/${data.events.next.id}`} size="sm">
                      Open event
                    </LinkButton>
                    {canCheckIn && (
                      <LinkButton href={`/org/check-in?event=${data.events.next.id}`} variant="secondary" size="sm" icon={ScanLine}>
                        Check-in
                      </LinkButton>
                    )}
                  </div>
                </div>
              ) : (
                <EmptyState
                  icon={MapPin}
                  title="No upcoming event"
                  description="Publish an event to start taking registrations."
                  action={
                    <LinkButton href="/org/events" size="sm">
                      Go to events
                    </LinkButton>
                  }
                />
              )}
            </Card>
          </div>

          <div className="grid gap-5 xl:grid-cols-5">
            <Card className={data.finance ? "xl:col-span-3" : "xl:col-span-5"}>
              <CardHeader
                title="Event performance"
                description={data.finance ? "Result is collected income minus paid expenses for entries linked to the event." : "Seats and turnout for each event."}
                action={
                  <LinkButton href="/org/events" variant="ghost" size="sm">
                    All events
                  </LinkButton>
                }
              />
              {data.eventPerformance.length === 0 ? (
                <EmptyState icon={CalendarDays} title="No published events yet" description="Results appear here once an event is published." />
              ) : (
                <Table stack>
                  <thead>
                    <tr>
                      <Th>Event</Th>
                      <Th>Seats</Th>
                      <Th align="right">Checked in</Th>
                      {data.finance && <Th align="right">Result</Th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.eventPerformance.map((e) => (
                      <tr key={e.id} className="transition-colors hover:bg-sunken/50">
                        <Td layout="lead">
                          <Link href={`/org/events/${e.id}`} className="rounded font-semibold text-ink hover:text-brand hover:underline">
                            {e.title}
                          </Link>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                            <EventStatusBadge status={e.status} phase={e.phase} />
                            {formatShortDateTime(e.startsAt)}
                          </div>
                        </Td>
                        <Td label="Seats" layout="block" className="sm:min-w-32">
                          <div className="num mb-1 text-[0.8125rem] text-body">
                            <span className="font-medium text-ink">{e.registered}</span> / {e.capacity}
                          </div>
                          <Meter value={e.registered} max={e.capacity} label={`Seats taken for ${e.title}`} />
                        </Td>
                        <Td label="Checked in" align="right">
                          {e.phase === "upcoming" ? <span className="text-subtle">Not started</span> : e.checkedIn}
                        </Td>
                        {e.netCents !== null && (
                          <Td label="Result" align="right">
                            <Money cents={e.netCents} signed colored className="font-semibold" />
                          </Td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            {data.finance && (
              <Card className="xl:col-span-2">
                <CardHeader title="Money in and out" description="By month. Collected and paid amounts only." />
                <div className="p-5">
                  {data.cashflow.length === 0 ? (
                    <EmptyState icon={Wallet} title="No transactions yet" description="Record income or an expense to see it here." />
                  ) : (
                    <CashflowChart months={data.cashflow} />
                  )}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The one number the committee asks for first, and what is still moving. */
function CashPosition({ finance }: { finance: FinanceTotals }) {
  return (
    <section aria-labelledby="cash-heading" className="overflow-hidden rounded-card bg-night shadow-card">
      <div className="grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="p-6 sm:p-7">
          <h2 id="cash-heading" className="flex items-center gap-2 text-[0.8125rem] font-semibold uppercase tracking-wider !text-on-night-muted">
            <Wallet className="size-4 text-accent" aria-hidden />
            Cash position
          </h2>
          <p className="num mt-3 font-display text-[2.75rem] font-extrabold leading-none tracking-tight text-white sm:text-[3.25rem]">
            <Money cents={finance.netCents} />
          </p>
          <p className="mt-3 text-sm text-on-night-muted">
            <Money cents={finance.incomeSettledCents} className="font-medium text-on-night" /> collected,{" "}
            <Money cents={finance.expenseSettledCents} className="font-medium text-on-night" /> paid out
          </p>
          <Link
            href="/org/finance"
            className="mt-5 inline-flex items-center gap-1.5 rounded-control text-sm font-semibold text-white underline-offset-4 hover:underline"
          >
            Open the ledger <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
        <dl className="grid grid-cols-2 gap-px border-t border-night-line bg-night-line sm:grid-cols-3 lg:border-l lg:border-t-0">
          {[
            { label: "Still to collect", cents: finance.incomePendingCents, note: "Unpaid tickets, dues and orders", estimate: false },
            { label: "Still to pay", cents: finance.expensePendingCents, note: "Claims and refunds owed", estimate: false },
            { label: "If it all settles", cents: finance.projectedNetCents, note: "Cash position after pending items", estimate: true },
          ].map((item) => (
            <div key={item.label} className={cn("bg-night px-5 py-5 sm:py-7", item.estimate && "max-sm:col-span-2")}>
              <dt className="text-[0.8125rem] font-medium text-on-night-muted">{item.label}</dt>
              <dd className="num mt-1.5 font-display text-2xl font-bold text-white">
                <Money cents={item.cents} />
              </dd>
              <dd className="mt-1.5 text-xs leading-snug text-on-night-muted">
                {item.estimate && (
                  <span className="mr-1.5 rounded-full bg-accent/20 px-2 py-0.5 text-[0.6875rem] font-semibold text-accent">Estimate</span>
                )}
                {item.note}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
