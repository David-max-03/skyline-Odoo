"use client";

import Link from "next/link";
import { CalendarDays, MapPin } from "lucide-react";
import { Money } from "@/components/domain";
import { Badge, Card, EmptyState, ErrorState, Meter, PageHeader, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api-client";
import type { PublicEvent } from "@/lib/contracts";
import { formatDateTime } from "@/lib/dates";

export default function PublicEventsPage() {
  const { data, error, reload } = useApi<PublicEvent[]>("/api/public/events");

  return (
    <>
      <PageHeader title="Events" description="Pick an event to register. You get a ticket with a QR code straight away; no account needed." />
      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : !data ? (
        <div className="space-y-4" role="status" aria-label="Loading events">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : data.length === 0 ? (
        <Card>
          <EmptyState icon={CalendarDays} title="No events are open right now" description="New events are announced on the news board." />
        </Card>
      ) : (
        <ul className="space-y-4">
          {data.map((event) => {
            const taken = event.capacity - event.remaining;
            return (
              <li key={event.id}>
                <Link
                  href={`/events/${event.id}`}
                  className="group grid gap-4 rounded-card border border-line bg-surface p-5 shadow-card transition-colors hover:border-brand-line sm:grid-cols-[1fr_13rem]"
                >
                  <div className="min-w-0">
                    <h2 className="text-xl font-bold group-hover:text-brand">{event.title}</h2>
                    <p className="mt-1 text-sm text-body">{formatDateTime(event.startsAt)}</p>
                    <p className="flex items-center gap-1 text-sm text-muted">
                      <MapPin className="size-3.5 shrink-0" aria-hidden />
                      {event.venue}
                    </p>
                    {event.description && <p className="mt-2 line-clamp-2 text-sm text-muted">{event.description}</p>}
                  </div>
                  <div className="flex flex-col justify-between gap-3 sm:items-end sm:text-right">
                    <div>
                      <p className="font-display text-lg font-bold text-ink">
                        {event.priceCents === 0 ? "Free" : <Money cents={event.priceCents} />}
                      </p>
                      {event.memberPriceCents < event.priceCents && (
                        <p className="text-[0.8125rem] text-muted">
                          Members <Money cents={event.memberPriceCents} />
                        </p>
                      )}
                    </div>
                    <div className="w-full">
                      <div className="mb-1 flex items-center justify-between gap-2 text-[0.8125rem] sm:justify-end">
                        {event.closedReason === "sold_out" ? (
                          <Badge tone="bad">Sold out</Badge>
                        ) : (
                          <span className="text-muted">
                            <span className="num font-medium text-ink">{event.remaining}</span> of {event.capacity} seats left
                          </span>
                        )}
                      </div>
                      <Meter value={taken} max={event.capacity} label={`Seats taken for ${event.title}`} tone={event.remaining === 0 ? "bad" : "brand"} />
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
