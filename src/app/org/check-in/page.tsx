"use client";

import { useSearchParams } from "next/navigation";
import { Ban, Banknote, CircleAlert, CircleCheck, CircleX, Info, ScanLine, Search, type LucideIcon } from "lucide-react";
import { Suspense, useRef, useState, type FormEvent } from "react";
import { Money, percent } from "@/components/domain";
import { useToast } from "@/components/overlay";
import { QrScanner } from "@/components/qr-scanner";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Meter,
  Notice,
  PageHeader,
  SelectField,
  TextField,
  cn,
} from "@/components/ui";
import { useCan } from "@/components/session";
import { api, errorMessage, useApi } from "@/lib/api-client";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type CheckInOutcome,
  type CheckInResult,
  type EventView,
  type PaymentMethod,
} from "@/lib/contracts";
import { formatShortDateTime } from "@/lib/dates";

const LOOK: Record<CheckInOutcome, { title: string; icon: LucideIcon; panel: string; iconBox: string }> = {
  checked_in: { title: "Checked in", icon: CircleCheck, panel: "border-ok/40 bg-ok-soft", iconBox: "bg-ok text-white" },
  valid: { title: "Valid ticket", icon: CircleCheck, panel: "border-ok/40 bg-ok-soft", iconBox: "bg-ok text-white" },
  already_checked_in: { title: "Already used", icon: CircleAlert, panel: "border-warn/40 bg-warn-soft", iconBox: "bg-accent text-ink" },
  payment_required: { title: "Payment needed", icon: Banknote, panel: "border-warn/40 bg-warn-soft", iconBox: "bg-accent text-ink" },
  wrong_event: { title: "Wrong event", icon: CircleX, panel: "border-bad/40 bg-bad-soft", iconBox: "bg-bad text-white" },
  cancelled: { title: "Ticket cancelled", icon: Ban, panel: "border-bad/40 bg-bad-soft", iconBox: "bg-bad text-white" },
  event_cancelled: { title: "Event cancelled", icon: Ban, panel: "border-bad/40 bg-bad-soft", iconBox: "bg-bad text-white" },
  not_found: { title: "Not a valid ticket", icon: CircleX, panel: "border-bad/40 bg-bad-soft", iconBox: "bg-bad text-white" },
};

interface LogEntry {
  at: string;
  result: CheckInResult;
}

function CheckInDesk() {
  const toast = useToast();
  const params = useSearchParams();
  const events = useApi<EventView[]>("/api/events");
  const [chosen, setChosen] = useState<string | null>(params.get("event"));
  const [code, setCode] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const canCollect = useCan("collectPayment");
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const [openedAt] = useState(() => Date.now());
  const distance = (e: EventView) => Math.abs(Date.parse(e.startsAt) - openedAt);
  const open = (events.data ?? []).filter((e) => e.status === "published").toSorted((a, b) => distance(a) - distance(b));
  // Default to the event closest to now: at the door that is almost always the right one.
  const eventId = chosen && open.some((e) => e.id === chosen) ? chosen : (open[0]?.id ?? null);
  const event = open.find((e) => e.id === eventId) ?? null;

  // One request at a time: a ticket held in front of the camera must not be sent twice.
  async function submit(raw: string, collectPayment = false) {
    const value = raw.trim();
    if (!value || !eventId || inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    try {
      const outcome = await api<CheckInResult>("/api/tickets/check-in", {
        method: "POST",
        body: { code: value, eventId, collectPayment, method },
      });
      setResult(outcome);
      // A buzz the door staff can feel without looking: one for "in", two for anything else.
      // Ignored by browsers and devices that do not support it.
      navigator.vibrate?.(outcome.outcome === "checked_in" ? 80 : [60, 70, 60]);
      // On a keyboard, be ready for the next code straight away.
      if (window.matchMedia("(pointer: fine)").matches) {
        const input = formRef.current?.querySelector("input");
        input?.focus();
        input?.select(); // typing replaces a code that was refused

      }
      setLog((entries) => [{ at: new Date().toISOString(), result: outcome }, ...entries].slice(0, 8));
      if (outcome.outcome === "checked_in") {
        setCode("");
        events.reload();
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }

  if (events.error && !events.data) {
    return (
      <Card>
        <ErrorState message={events.error.message} onRetry={events.reload} />
      </Card>
    );
  }
  if (!events.data) {
    return (
      <Card>
        <LoadingBlock label="Loading events" />
      </Card>
    );
  }
  if (open.length === 0) {
    return (
      <Card>
        <EmptyState icon={ScanLine} title="No published events" description="Publish an event before checking people in." />
      </Card>
    );
  }

  const look = result ? LOOK[result.outcome] : null;

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="space-y-5 lg:col-span-3">
        <Card className="p-5">
          <SelectField label="Event at this door" value={eventId ?? ""} onChange={(e) => { setChosen(e.target.value); setResult(null); }}>
            {open.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title} · {formatShortDateTime(e.startsAt)}
              </option>
            ))}
          </SelectField>
          {event && (
            <div className="mt-4">
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="font-medium text-ink">
                  <span className="num">{event.stats.checkedIn}</span> of <span className="num">{event.stats.registered}</span> checked in
                </span>
                <span className="num text-muted">{event.stats.registered ? percent(event.stats.checkedIn / event.stats.registered) : "—"}</span>
              </div>
              <Meter value={event.stats.checkedIn} max={event.stats.registered} label="Checked in" tone="ok" />
            </div>
          )}
        </Card>

        <Card className="p-5">
          <QrScanner onScan={(text) => void submit(text)} />
          <form
            ref={formRef}
            className="mt-5 flex items-start gap-2 border-t border-line pt-5"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void submit(code);
            }}
          >
            <TextField
              className="flex-1"
              label="Or type the ticket code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="SKY-XXXXX-XXXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              hint="Works when the camera does not. Spaces and dashes are optional."
            />
            <Button type="submit" icon={Search} loading={working} disabled={!code.trim()} className="mt-[1.6875rem]">
              Check in
            </Button>
          </form>
        </Card>
      </div>

      <div className="order-first space-y-5 lg:sticky lg:top-6 lg:order-none lg:col-span-2 lg:self-start">
        <div aria-live="assertive">
          {result && look ? (
            <div key={log[0]?.at} className={cn("animate-pop overflow-hidden rounded-card border-2 shadow-raised", look.panel)}>
              {/* The verdict: readable at arm's length, and never by colour alone. */}
              <div className={cn("flex items-center gap-4 px-5 py-5", look.iconBox)}>
                <look.icon className="size-11 shrink-0" strokeWidth={2.25} aria-hidden />
                <div className="min-w-0">
                  <p className="font-display text-[1.75rem] font-extrabold leading-tight">{look.title}</p>
                  <p className="text-sm font-medium opacity-90">{result.message}</p>
                </div>
              </div>
              <div className="p-5">
              {result.ticket && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt className="sr-only">Name</dt>
                  <dd className="col-span-2 mb-1 font-display text-xl font-bold text-ink">{result.ticket.attendeeName}</dd>
                  <dt className="text-muted">Ticket</dt>
                  <dd className="font-mono text-[0.8125rem] text-ink">{result.ticket.code}</dd>
                  <dt className="text-muted">Membership</dt>
                  <dd className="text-ink">{result.ticket.isMember ? `Member ${result.ticket.memberNo ?? ""}` : "Not a member ticket"}</dd>
                  {result.outcome === "already_checked_in" && result.ticket.checkedInAt && (
                    <>
                      <dt className="text-muted">First used</dt>
                      <dd className="text-ink">
                        {formatShortDateTime(result.ticket.checkedInAt)}
                        {result.ticket.checkedInByName && ` by ${result.ticket.checkedInByName}`}
                      </dd>
                    </>
                  )}
                </dl>
              )}
              {result.outcome === "payment_required" && result.ticket && !canCollect && (
                <p className="mt-4 border-t border-ink/10 pt-4 text-sm font-medium text-ink">
                  This ticket is not paid. Send them to the treasurer or the president; scan again once the payment is recorded.
                </p>
              )}
              {result.outcome === "payment_required" && result.ticket && canCollect && (
                <div className="mt-4 border-t border-ink/10 pt-4">
                  <p className="text-sm font-medium text-ink">
                    Collect <Money cents={result.ticket.priceCents} className="font-bold" /> before letting them in.
                  </p>
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <SelectField label="Paid by" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className="w-36">
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {PAYMENT_METHOD_LABELS[m]}
                        </option>
                      ))}
                    </SelectField>
                    <Button icon={Banknote} loading={working} onClick={() => void submit(result.ticket!.code, true)}>
                      Payment received, check in
                    </Button>
                  </div>
                </div>
              )}
              {!result.ticket && <p className="text-sm text-body">Ask to see the ticket again, or look the person up under the event&rsquo;s registrations.</p>}
              </div>
            </div>
          ) : (
            <Card>
              <EmptyState icon={ScanLine} title="Ready to scan" description="The result of each scan appears here: who it is, and whether to let them in." />
            </Card>
          )}
        </div>

        <Card>
          <CardHeader title="This session" description="The last few scans on this device." />
          {log.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted">Nothing scanned yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {log.map((entry) => (
                <li key={entry.at} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <span className="min-w-0 truncate text-ink">{entry.result.ticket?.attendeeName ?? "Unknown code"}</span>
                  <Badge tone={entry.result.outcome === "checked_in" ? "ok" : entry.result.outcome === "already_checked_in" || entry.result.outcome === "payment_required" ? "warn" : "bad"}>
                    {LOOK[entry.result.outcome].title}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function CheckInPage() {
  const canCheckIn = useCan("checkIn");
  if (!canCheckIn) {
    return (
      <>
        <PageHeader title="Check-in" />
        <Notice tone="neutral" icon={Info}>
          The door is run by the president and the event handler. Your role does not include check-in; ticket payments are recorded
          from the event page.
        </Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Check-in"
        description="Scan a ticket or type its code. The server decides: each ticket gets in once, and unpaid tickets are flagged before entry."
      />
      <Suspense fallback={<Card><LoadingBlock label="Loading" /></Card>}>
        <CheckInDesk />
      </Suspense>
    </>
  );
}
