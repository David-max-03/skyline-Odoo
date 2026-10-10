"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, MapPin, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { EventStatusBadge, Money } from "@/components/domain";
import { EventForm } from "@/components/event-form";
import { Dialog, useToast } from "@/components/overlay";
import { useCan } from "@/components/session";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Meter,
  PageHeader,
  Segmented,
  Table,
  TableSkeleton,
  Td,
  Th,
} from "@/components/ui";
import { DateBlock } from "@/components/domain";
import { useApi } from "@/lib/api-client";
import type { EventSummary } from "@/lib/contracts";
import { formatDateTime } from "@/lib/dates";

type Filter = "all" | "upcoming" | "past" | "draft";

const matches = (e: EventSummary, filter: Filter) => {
  if (filter === "draft") return e.status === "draft";
  if (filter === "upcoming") return e.status === "published" && e.phase !== "past";
  if (filter === "past") return e.status === "cancelled" || (e.status === "published" && e.phase === "past");
  return true;
};

export default function EventsPage() {
  const router = useRouter();
  const toast = useToast();
  const canManage = useCan("manageEvents");
  const { data, error, reload } = useApi<EventSummary[]>("/api/events");
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);

  const visible = useMemo(() => {
    const list = (data ?? []).filter((e) => matches(e, filter));
    // Soonest upcoming first; finished events most recent first.
    return list.sort((a, b) => {
      const aUp = a.phase !== "past" ? 0 : 1;
      const bUp = b.phase !== "past" ? 0 : 1;
      if (aUp !== bUp) return aUp - bUp;
      return aUp === 0 ? a.startsAt.localeCompare(b.startsAt) : b.startsAt.localeCompare(a.startsAt);
    });
  }, [data, filter]);

  const count = (f: Filter) => (data ?? []).filter((e) => matches(e, f)).length;

  return (
    <>
      <PageHeader
        title="Events"
        description="Create an event as a draft, publish it to open registration, and follow seats and money as they come in."
        actions={
          canManage && (
            <Button icon={Plus} onClick={() => setCreating(true)}>
              New event
            </Button>
          )
        }
      />

      <div className="mb-4">
        <Segmented
          label="Filter events"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: count("all") },
            { value: "upcoming", label: "Upcoming", count: count("upcoming") },
            { value: "past", label: "Finished", count: count("past") },
            { value: "draft", label: "Drafts", count: count("draft") },
          ]}
        />
      </div>

      <Card>
        {error && !data ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : !data ? (
          <TableSkeleton label="Loading events" />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title={data.length === 0 ? "No events yet" : "No events match this filter"}
            description={data.length === 0 ? "Create your first event. It starts as a draft that only the committee can see." : undefined}
            action={
              data.length === 0 && canManage ? (
                <Button icon={Plus} onClick={() => setCreating(true)}>
                  New event
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table stack>
            <thead>
              <tr>
                <Th>Event</Th>
                <Th>Status</Th>
                <Th>Seats</Th>
                <Th align="right">Price</Th>
                <Th align="right">Result</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <tr key={e.id} className="transition-colors hover:bg-sunken/50">
                  <Td layout="lead">
                    <div className="flex items-start gap-3.5">
                      <DateBlock iso={e.startsAt} muted={e.phase === "past" || e.status !== "published"} />
                      <div className="min-w-0">
                        <Link href={`/org/events/${e.id}`} className="rounded font-semibold text-ink hover:text-brand hover:underline">
                          {e.title}
                        </Link>
                        <div className="mt-0.5 text-[0.8125rem] text-muted">{formatDateTime(e.startsAt)}</div>
                        <div className="flex items-center gap-1 text-[0.8125rem] text-muted">
                          <MapPin className="size-3.5 shrink-0" aria-hidden />
                          {e.venue}
                        </div>
                      </div>
                    </div>
                  </Td>
                  <Td label="Status">
                    <EventStatusBadge status={e.status} phase={e.phase} />
                  </Td>
                  <Td label="Seats" layout="block" className="sm:min-w-36">
                    <div className="num mb-1 text-[0.8125rem]">
                      <span className="font-medium text-ink">{e.stats.registered}</span> / {e.capacity}
                      {e.phase !== "past" && e.status !== "cancelled" && <span className="text-muted"> · {e.stats.remaining} left</span>}
                    </div>
                    <Meter
                      value={e.stats.registered}
                      max={e.capacity}
                      label={`Seats taken for ${e.title}`}
                      tone={e.stats.remaining === 0 ? "bad" : e.stats.remaining <= e.capacity * 0.1 ? "warn" : "brand"}
                    />
                  </Td>
                  <Td label="Price" align="right">
                    <div>
                      {e.priceCents === 0 ? <span className="text-muted">Free</span> : <Money cents={e.priceCents} />}
                      {e.memberPriceCents !== e.priceCents && (
                        <div className="text-xs text-muted">
                          members <Money cents={e.memberPriceCents} />
                        </div>
                      )}
                    </div>
                  </Td>
                  <Td label="Result" align="right">
                    <Money cents={e.finance.netCents} signed colored className="font-semibold" />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New event"
        description="It is saved as a draft. Nothing is public until you publish it."
      >
        <EventForm
          onCancel={() => setCreating(false)}
          onSaved={(event) => {
            setCreating(false);
            toast.success(`“${event.title}” saved as a draft. Publish it to open registration.`);
            router.push(`/org/events/${event.id}`);
          }}
        />
      </Dialog>
    </>
  );
}
