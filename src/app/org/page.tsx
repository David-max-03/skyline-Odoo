"use client";

import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Info,
  ScanLine,
  Ticket,
  Users,
  Wallet,
} from "lucide-react";
import { CashflowChart } from "@/components/charts";
import { EventStatusBadge, Money, percent } from "@/components/domain";
import { useSession } from "@/components/session";
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LinkButton,
  LoadingBlock,
  Meter,
  PageHeader,
  Skeleton,
  Stat,
  Table,
  Td,
  Th,
  cn,
} from "@/components/ui";
import { useApi } from "@/lib/api-client";
import type { Dashboard } from "@/lib/contracts";
import { formatDateTime, formatShortDateTime } from "@/lib/dates";

export default function DashboardPage() {
  const user = useSession();
  const { data, error, loading, reload } = useApi<Dashboard>("/api/dashboard");

  return (
    <>
      <PageHeader
        title={`Hello, ${user.name.split(" ")[0]}`}
        description="What needs attention, and how the club is doing. Every figure is read from the records."
        actions={
          <>
            <LinkButton href="/org/check-in" variant="secondary" icon={ScanLine}>
              Check-in
            </LinkButton>
            <LinkButton href="/org/events" icon={CalendarDays}>
              Events
            </LinkButton>
          </>
        }
      />

      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : !data ? (
        <div role="status" aria-label="Loading dashboard" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-64" />
        </div>
      ) : (
        <div className={cn("space-y-6 transition-opacity", loading && "opacity-70")}>
          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader title="Needs attention" description="Ordered by urgency. Each item links to where you fix it." />
              {data.alerts.length === 0 ? (
                <EmptyState icon={CircleCheck} title="Nothing is waiting on you" description="No overdue tasks, unpaid claims or expiring memberships." />
              ) : (
                <ul>
                  {data.alerts.map((alert) => (
                    <li key={alert.kind} className="border-b border-line last:border-0">
                      <Link href={alert.href} className="group flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-sunken/60">
                        <span
                          className={cn(
                            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
                            alert.severity === "warning" ? "bg-warn-soft text-warn" : "bg-brand-soft text-brand-deep",
                          )}
                        >
                          {alert.severity === "warning" ? <CircleAlert className="size-4" aria-hidden /> : <Info className="size-4" aria-hidden />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-ink">{alert.title}</span>
                          <span className="block text-[0.8125rem] text-muted">{alert.detail}</span>
                        </span>
                        <ChevronRight className="mt-1.5 size-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader title="Next event" />
              {data.events.next ? (
                <div className="p-5">
                  <p className="font-display text-xl font-bold text-ink">{data.events.next.title}</p>
                  <p className="mt-1 text-sm text-muted">{formatDateTime(data.events.next.startsAt)}</p>
                  <div className="mt-5">
                    <div className="mb-1.5 flex items-baseline justify-between text-sm">
                      <span className="font-medium text-ink">
                        <span className="num">{data.events.next.registered}</span> of <span className="num">{data.events.next.capacity}</span> seats taken
                      </span>
                      <span className="num text-muted">{percent(data.events.next.registered / data.events.next.capacity)}</span>
                    </div>
                    <Meter value={data.events.next.registered} max={data.events.next.capacity} label="Seats taken" />
                  </div>
                  <LinkButton href={`/org/events/${data.events.next.id}`} variant="secondary" size="sm" className="mt-5">
                    Open event <ArrowRight className="size-4" aria-hidden />
                  </LinkButton>
                </div>
              ) : (
                <EmptyState
                  icon={CalendarDays}
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

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Cash position"
              icon={Wallet}
              tone="brand"
              value={<Money cents={data.finance.netCents} />}
              detail={
                <>
                  <Money cents={data.finance.incomeSettledCents} /> collected · <Money cents={data.finance.expenseSettledCents} /> paid out
                </>
              }
            />
            <Stat
              label="Still to settle"
              icon={CircleAlert}
              tone="warn"
              value={<Money cents={data.finance.incomePendingCents - data.finance.expensePendingCents} signed />}
              detail={
                <>
                  <Money cents={data.finance.incomePendingCents} /> to collect · <Money cents={data.finance.expensePendingCents} /> owed
                </>
              }
            />
            <Stat
              label="Active members"
              icon={Users}
              tone="ok"
              value={data.members.active}
              detail={`of ${data.members.total} on the list · ${data.members.expiring} due to renew · ${data.members.unpaid} unpaid`}
            />
            <Stat
              label="Registrations"
              icon={Ticket}
              tone="brand"
              value={data.tickets.registered}
              detail={`${data.tickets.paid} paid · ${data.tickets.pending} unpaid · ${data.tickets.free} free · turnout ${percent(data.tickets.attendanceRate)}`}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-5">
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

            <Card className="xl:col-span-3">
              <CardHeader
                title="Event performance"
                description="Result = collected income − paid expenses, for entries linked to the event."
                action={
                  <LinkButton href="/org/events" variant="ghost" size="sm">
                    All events
                  </LinkButton>
                }
              />
              {data.eventPerformance.length === 0 ? (
                <EmptyState icon={CalendarDays} title="No published events yet" />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Event</Th>
                      <Th>Seats</Th>
                      <Th align="right">Checked in</Th>
                      <Th align="right">Result</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.eventPerformance.map((e) => (
                      <tr key={e.id} className="hover:bg-sunken/50">
                        <Td>
                          <Link href={`/org/events/${e.id}`} className="font-medium text-ink hover:text-brand hover:underline">
                            {e.title}
                          </Link>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                            <EventStatusBadge status={e.status} phase={e.phase} />
                            {formatShortDateTime(e.startsAt)}
                          </div>
                        </Td>
                        <Td className="min-w-32">
                          <div className="num mb-1 text-[0.8125rem] text-body">
                            {e.registered} / {e.capacity}
                          </div>
                          <Meter value={e.registered} max={e.capacity} label={`Seats taken for ${e.title}`} />
                        </Td>
                        <Td align="right">{e.phase === "upcoming" ? <span className="text-subtle">—</span> : e.checkedIn}</Td>
                        <Td align="right">
                          <Money cents={e.netCents} signed colored className="font-medium" />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
          {loading && <LoadingBlock rows={0} label="Refreshing" />}
        </div>
      )}
    </>
  );
}
