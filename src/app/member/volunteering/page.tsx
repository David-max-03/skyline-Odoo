"use client";

import { CalendarDays, Check, HandHeart, Hourglass, MapPin, Undo2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { TaskStatusBadge } from "@/components/domain";
import { useToast } from "@/components/overlay";
import { Badge, Button, Card, CardHeader, CheckboxField, EmptyState, ErrorState, LinkButton, LoadingBlock, PageHeader, SelectField, TextField, type Tone } from "@/components/ui";
import { api, errorMessage, useApi } from "@/lib/api-client";
import {
  VOLUNTEER_REQUEST_STATUS_LABELS,
  type MemberVolunteering,
  type MyVolunteerRequest,
  type VolunteerOpportunity,
  type VolunteerRequestStatus,
} from "@/lib/contracts";
import { formatDate, formatDateTime, formatShortDateTime } from "@/lib/dates";

const STATUS_TONES: Record<VolunteerRequestStatus, Tone> = { pending: "warn", approved: "ok", rejected: "bad", withdrawn: "neutral" };
const GENERAL = "general";

/**
 * Tasks the committee has opened to volunteers, and this member's own
 * requests. Asking to help never assigns anything: an organizer or the
 * president approves, and only then does the task appear under My tasks.
 */
export default function MemberVolunteeringPage() {
  const toast = useToast();
  const { data, error, reload } = useApi<MemberVolunteering>("/api/me/volunteering");
  const [busy, setBusy] = useState<string | null>(null);
  const [eventFilter, setEventFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);

  const opportunities = useMemo(() => data?.opportunities ?? [], [data]);
  const events = useMemo(() => {
    const seen = new Map<string, string>();
    for (const o of opportunities) if (o.eventId && o.eventTitle) seen.set(o.eventId, o.eventTitle);
    return [...seen];
  }, [opportunities]);
  const hasGeneral = opportunities.some((o) => !o.eventId);

  const visible = opportunities.filter(
    (o) =>
      (!eventFilter || (eventFilter === GENERAL ? !o.eventId : o.eventId === eventFilter)) &&
      (!fromDate || (o.eventStartsAt ?? "").slice(0, 10) >= fromDate) &&
      (!onlyOpen || !o.isFull) &&
      (!onlyMine || o.myRequest !== null),
  );
  const groups = useMemo(() => {
    const byEvent = new Map<string, VolunteerOpportunity[]>();
    for (const o of visible) byEvent.set(o.eventId ?? GENERAL, [...(byEvent.get(o.eventId ?? GENERAL) ?? []), o]);
    return [...byEvent.values()];
  }, [visible]);
  const filtered = Boolean(eventFilter || fromDate || onlyOpen || onlyMine);

  async function ask(o: VolunteerOpportunity) {
    setBusy(o.taskId);
    try {
      await api<MyVolunteerRequest>("/api/me/volunteering", { method: "POST", body: { taskId: o.taskId } });
      toast.success(`Request sent for "${o.title}". It is waiting for an organizer to approve.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      reload();
    }
  }

  async function withdraw(request: MyVolunteerRequest) {
    setBusy(request.id);
    try {
      await api<MyVolunteerRequest>(`/api/me/volunteering/${request.id}`, { method: "POST", body: { action: "withdraw" } });
      toast.success(`Request for "${request.taskTitle}" withdrawn.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      reload();
    }
  }

  return (
    <>
      <PageHeader
        title="Volunteer"
        description="Tasks the committee needs help with. Ask to volunteer; an organizer approves, and the task then appears under My tasks."
        actions={
          <LinkButton href="/member/tasks" variant="secondary">
            My tasks
          </LinkButton>
        }
      />

      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : !data ? (
        <Card>
          <LoadingBlock label="Loading volunteer opportunities" />
        </Card>
      ) : (
        <div className="space-y-6">
          <section aria-labelledby="opportunities">
            <h2 id="opportunities" className="mb-3 text-[0.9375rem] font-semibold">
              Volunteer opportunities
            </h2>
            {opportunities.length > 0 && (
              <Card className="mb-4 grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
                <SelectField label="Event" value={eventFilter} onChange={(e) => setEventFilter(e.target.value)}>
                  <option value="">All events</option>
                  {events.map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                  {hasGeneral && <option value={GENERAL}>Not tied to an event</option>}
                </SelectField>
                <TextField label="Event on or after" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
                <CheckboxField label="Needs volunteers" hint="Hide tasks that are fully staffed" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />
                <CheckboxField label="My requests" hint="Only tasks I have asked for" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
              </Card>
            )}

            {opportunities.length === 0 ? (
              <Card>
                <EmptyState icon={HandHeart} title="Nothing needs volunteers right now" description="When the committee opens a task to volunteers, it shows here." />
              </Card>
            ) : groups.length === 0 ? (
              <Card>
                <EmptyState
                  icon={HandHeart}
                  title="No tasks match these filters"
                  description="Change or clear the filters to see more."
                  action={
                    filtered ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setEventFilter("");
                          setFromDate("");
                          setOnlyOpen(false);
                          setOnlyMine(false);
                        }}
                      >
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              </Card>
            ) : (
              <div className="space-y-4">
                {groups.map((group) => {
                  const head = group[0];
                  return (
                    <Card key={head.eventId ?? GENERAL}>
                      <header className="border-b border-line px-5 py-3.5">
                        <h3 className="text-[0.9375rem] font-semibold text-ink">{head.eventTitle ?? "Not tied to an event"}</h3>
                        {head.eventStartsAt && (
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-muted">
                            <span className="inline-flex items-center gap-1">
                              <CalendarDays className="size-3.5" aria-hidden />
                              {formatDateTime(head.eventStartsAt)}
                            </span>
                            {head.eventVenue && (
                              <span className="inline-flex items-center gap-1">
                                <MapPin className="size-3.5" aria-hidden />
                                {head.eventVenue}
                              </span>
                            )}
                          </p>
                        )}
                      </header>
                      <ul className="divide-y divide-line">
                        {group.map((o) => (
                          <li key={o.taskId} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-5 py-4">
                            <div className="min-w-0 flex-1 basis-64 text-sm">
                              <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                                {o.title}
                                <TaskStatusBadge status={o.taskStatus} />
                              </p>
                              {o.description && <p className="mt-1 text-[0.8125rem] text-muted">{o.description}</p>}
                              <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-muted">
                                <div>
                                  <dt className="inline">Volunteers needed: </dt>
                                  <dd className="inline font-medium text-ink">{o.needed}</dd>
                                </div>
                                <div>
                                  <dt className="inline">Approved: </dt>
                                  <dd className="inline font-medium text-ink">{o.approved}</dd>
                                </div>
                                <div>
                                  <dt className="inline">Pending: </dt>
                                  <dd className="inline font-medium text-ink">{o.pending}</dd>
                                </div>
                                {o.dueOn && (
                                  <div>
                                    <dt className="inline">Due: </dt>
                                    <dd className="inline font-medium text-ink">{formatDate(o.dueOn)}</dd>
                                  </div>
                                )}
                              </dl>
                            </div>
                            <div className="flex flex-col items-start gap-2 sm:items-end">
                              <Badge tone={o.isFull ? "neutral" : "brand"}>
                                {o.isFull ? "Fully staffed" : `${o.remaining} ${o.remaining === 1 ? "position" : "positions"} open`}
                              </Badge>
                              {o.assignedToMe ? (
                                <Badge tone="ok" icon={Check}>
                                  Assigned to you
                                </Badge>
                              ) : o.myRequest ? (
                                <Badge tone={STATUS_TONES[o.myRequest.status]} icon={o.myRequest.status === "pending" ? Hourglass : Check}>
                                  {o.myRequest.status === "pending" ? "You asked · pending approval" : "You are approved"}
                                </Badge>
                              ) : (
                                <Button size="sm" icon={HandHeart} disabled={o.isFull || busy !== null} loading={busy === o.taskId} onClick={() => ask(o)}>
                                  Request to volunteer
                                </Button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>

          <section aria-labelledby="my-requests">
            <Card>
              <CardHeader title={<span id="my-requests">My volunteer requests</span>} description="Every request you have made and where it stands." />
              {data.requests.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">You have not asked to volunteer for anything yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.requests.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                      <div className="min-w-0 text-sm">
                        <p className="font-medium text-ink">{r.taskTitle}</p>
                        <p className="text-[0.8125rem] text-muted">
                          {r.eventTitle ?? "Not tied to an event"} · asked {formatShortDateTime(r.requestedAt)}
                        </p>
                        {r.status === "rejected" && r.reviewNote && <p className="mt-1 text-[0.8125rem] text-bad">Reason: {r.reviewNote}</p>}
                        {r.status === "approved" && <p className="mt-1 text-[0.8125rem] text-muted">This task is now in My tasks.</p>}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone={STATUS_TONES[r.status]} icon={r.status === "pending" ? Hourglass : r.status === "approved" ? Check : r.status === "rejected" ? X : undefined}>
                          {VOLUNTEER_REQUEST_STATUS_LABELS[r.status]}
                        </Badge>
                        {r.status === "pending" && (
                          <Button size="sm" variant="secondary" icon={Undo2} disabled={busy !== null} loading={busy === r.id} onClick={() => withdraw(r)}>
                            Withdraw
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>
        </div>
      )}
    </>
  );
}
