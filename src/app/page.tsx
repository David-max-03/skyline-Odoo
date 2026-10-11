"use client";

import Link from "next/link";
import { ArrowRight, CalendarDays, MapPin, Megaphone, Shirt, UserPlus } from "lucide-react";
import { Money } from "@/components/domain";
import { PublicShell } from "@/components/public-shell";
import { Badge, Card, EmptyState, ErrorState, LinkButton, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api-client";
import { SETTINGS, type PublicAnnouncement, type PublicEvent } from "@/lib/contracts";
import { formatDateTime } from "@/lib/dates";

export default function HomePage() {
  const events = useApi<PublicEvent[]>("/api/public/events");
  const news = useApi<PublicAnnouncement[]>("/api/public/announcements");
  const latest = news.data?.[0];

  return (
    <PublicShell>
      {/* Spacing on this page is set here, not in the shared shell, so no other page moves. */}
      <section className="grid items-center gap-6 rounded-card bg-night px-5 py-7 sm:px-8 sm:py-9 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,24rem)] xl:px-12 xl:py-12">
        <div>
        <p className="text-[0.8125rem] font-semibold uppercase tracking-wider text-accent">{SETTINGS.orgName}</p>
        <h1 className="mt-2 max-w-2xl text-[1.75rem] font-extrabold leading-tight !text-white sm:text-[2.35rem] sm:leading-[1.1]">
          Events, membership and merch, all in one place.
        </h1>
        <p className="mt-3 max-w-xl text-[0.9375rem] text-on-night-muted sm:text-base">
          Grab a ticket in a minute, keep it on your phone, and show the QR code at the door. Members pay less.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <LinkButton href="/events" size="lg" icon={CalendarDays}>
            See what&rsquo;s on
          </LinkButton>
          <LinkButton href="/join" size="lg" variant="secondary" icon={UserPlus}>
            Become a member
          </LinkButton>
        </div>
        </div>

        {/* The next real event, shown as a ticket. Hidden until events load, and when there are none. */}
        {events.data?.[0] && (
          <Link
            href={`/events/${events.data[0].id}`}
            className="group hidden overflow-hidden rounded-card bg-surface shadow-raised transition-transform hover:-translate-y-0.5 lg:block"
          >
            <div className="border-b-2 border-dashed border-line px-5 pb-3 pt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-brand">Next up</p>
              <p className="mt-1 font-display text-lg font-bold leading-snug text-ink group-hover:text-brand">{events.data[0].title}</p>
              <p className="mt-1.5 text-[0.8125rem] text-muted">{formatDateTime(events.data[0].startsAt)}</p>
              <p className="flex items-center gap-1 text-[0.8125rem] text-muted">
                <MapPin className="size-3.5 shrink-0" aria-hidden />
                {events.data[0].venue}
              </p>
            </div>
            <div className="flex items-center justify-between gap-3 px-5 py-3">
              <span className="text-sm">
                <span className="font-display font-bold text-ink">
                  {events.data[0].priceCents === 0 ? "Free" : <Money cents={events.data[0].priceCents} />}
                </span>
                <span className="text-muted">
                  {" "}
                  · {events.data[0].closedReason === "sold_out" ? "sold out" : `${events.data[0].remaining} seats left`}
                </span>
              </span>
              <span className="inline-flex items-center gap-1 text-sm font-semibold text-brand">
                Get a ticket <ArrowRight className="size-4" aria-hidden />
              </span>
            </div>
          </Link>
        )}
      </section>

      {latest && (
        <Link
          href="/news"
          className="mt-3 flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-2.5 shadow-card transition-colors hover:border-brand-line sm:mt-4"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-deep">
            <Megaphone className="size-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink">{latest.title}</span>
            <span className="line-clamp-2 text-[0.8125rem] text-muted sm:line-clamp-1">{latest.body}</span>
          </span>
          <ArrowRight className="size-4 shrink-0 text-subtle" aria-hidden />
        </Link>
      )}

      <section className="mt-6 sm:mt-7" aria-labelledby="upcoming">
        <div className="mb-3 flex items-end justify-between gap-4">
          <h2 id="upcoming" className="text-xl font-bold">
            Coming up
          </h2>
          <Link href="/events" className="text-sm font-medium text-brand hover:underline">
            All events
          </Link>
        </div>
        {events.error && !events.data ? (
          <Card>
            <ErrorState message={events.error.message} onRetry={events.reload} />
          </Card>
        ) : !events.data ? (
          <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(18rem,1fr))]" role="status" aria-label="Loading events">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : events.data.length === 0 ? (
          <Card>
            <EmptyState icon={CalendarDays} title="Nothing scheduled right now" description="Check back soon, or read the news board for updates." />
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(18rem,1fr))]">
            {events.data.slice(0, 4).map((event) => (
              <Link
                key={event.id}
                href={`/events/${event.id}`}
                className="group flex flex-col rounded-card border border-line bg-surface p-4 shadow-card transition-colors hover:border-brand-line"
              >
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {event.closedReason === "sold_out" ? (
                    <Badge tone="bad">Sold out</Badge>
                  ) : event.remaining <= Math.max(3, event.capacity * 0.1) ? (
                    <Badge tone="warn">{event.remaining} seats left</Badge>
                  ) : (
                    <Badge tone="brand">Open</Badge>
                  )}
                </div>
                <h3 className="text-[1.0625rem] font-bold leading-snug group-hover:text-brand">{event.title}</h3>
                <p className="mt-0.5 text-sm text-muted">{formatDateTime(event.startsAt)}</p>
                <p className="flex items-center gap-1 text-sm text-muted">
                  <MapPin className="size-3.5 shrink-0" aria-hidden />
                  {event.venue}
                </p>
                <p className="mt-auto pt-2.5 text-sm font-semibold text-ink">
                  {event.priceCents === 0 ? "Free" : <Money cents={event.priceCents} />}
                  {event.memberPriceCents < event.priceCents && (
                    <span className="font-normal text-muted">
                      {" "}
                      · members <Money cents={event.memberPriceCents} />
                    </span>
                  )}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6 grid gap-3 sm:mt-7 sm:grid-cols-2">
        <Link href="/shop" className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 shadow-card transition-colors hover:border-brand-line">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-deep">
            <Shirt className="size-5" aria-hidden />
          </span>
          <span>
            <span className="block font-display font-bold text-ink">Club hoodies and tees</span>
            <span className="block text-sm text-muted">Order your size from your phone. See what is in stock.</span>
          </span>
        </Link>
        <Link href="/join" className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 shadow-card transition-colors hover:border-brand-line">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-deep">
            <UserPlus className="size-5" aria-hidden />
          </span>
          <span>
            <span className="block font-display font-bold text-ink">
              Membership · <Money cents={SETTINGS.membershipFeeCents} /> a year
            </span>
            <span className="block text-sm text-muted">Cheaper tickets and merchandise until 31 December.</span>
          </span>
        </Link>
      </section>
    </PublicShell>
  );
}
