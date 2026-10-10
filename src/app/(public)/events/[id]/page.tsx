"use client";

import { useParams, useRouter } from "next/navigation";
import { CalendarDays, Clock, MapPin, Ticket, Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Money } from "@/components/domain";
import { Button, Card, ErrorState, FormError, Meter, Notice, PageHeader, Skeleton, TextField } from "@/components/ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import type { PublicEvent } from "@/lib/contracts";
import { formatDateTime, formatTime } from "@/lib/dates";

export default function PublicEventPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: event, error, reload } = useApi<PublicEvent>(`/api/public/events/${id}`);
  const [values, setValues] = useState({ name: "", email: "", studentId: "", memberNo: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function register(e: FormEvent) {
    e.preventDefault();
    setWorking(true);
    setFormError(null);
    setErrors({});
    try {
      const ticket = await api<{ code: string }>(`/api/public/events/${id}/register`, {
        method: "POST",
        body: { ...values, studentId: values.studentId || null, memberNo: values.memberNo || null },
      });
      router.push(`/t/${ticket.code}?new=1`);
    } catch (err) {
      setErrors(fieldErrors(err));
      setFormError(errorMessage(err));
      setWorking(false);
      reload(); // seats may have changed
    }
  }

  if (error && !event) {
    return (
      <>
        <PageHeader title="Event" back={{ href: "/events", label: "All events" }} />
        <Card>
          <ErrorState message={error.status === 404 ? "This event is not open for registration." : error.message} onRetry={reload} />
        </Card>
      </>
    );
  }
  if (!event) {
    return (
      <div role="status" aria-label="Loading event" className="space-y-4">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  const hasMemberPrice = event.memberPriceCents < event.priceCents;

  return (
    <>
      <PageHeader back={{ href: "/events", label: "All events" }} title={event.title} />
      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <div className="space-y-5">
          <Card className="p-5">
            <dl className="space-y-3 text-sm">
              <div className="flex gap-3">
                <dt>
                  <CalendarDays className="size-5 text-muted" aria-hidden />
                  <span className="sr-only">When</span>
                </dt>
                <dd className="text-ink">
                  {formatDateTime(event.startsAt)}
                  <span className="text-muted"> until {formatTime(event.endsAt)}</span>
                </dd>
              </div>
              <div className="flex gap-3">
                <dt>
                  <MapPin className="size-5 text-muted" aria-hidden />
                  <span className="sr-only">Where</span>
                </dt>
                <dd className="text-ink">{event.venue}</dd>
              </div>
              <div className="flex gap-3">
                <dt>
                  <Ticket className="size-5 text-muted" aria-hidden />
                  <span className="sr-only">Price</span>
                </dt>
                <dd className="text-ink">
                  {event.priceCents === 0 ? "Free entry" : <Money cents={event.priceCents} />}
                  {hasMemberPrice && (
                    <span className="text-muted">
                      {" "}
                      · members <Money cents={event.memberPriceCents} />
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt>
                  <Users className="size-5 text-muted" aria-hidden />
                  <span className="sr-only">Seats</span>
                </dt>
                <dd className="flex-1">
                  <span className="text-ink">
                    <span className="num font-semibold">{event.remaining}</span> of {event.capacity} seats left
                  </span>
                  <div className="mt-1.5 max-w-xs">
                    <Meter value={event.capacity - event.remaining} max={event.capacity} label="Seats taken" tone={event.remaining === 0 ? "bad" : "brand"} />
                  </div>
                </dd>
              </div>
            </dl>
          </Card>
          {event.description && (
            <Card className="p-5">
              <h2 className="text-[0.9375rem] font-semibold">About this event</h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed">{event.description}</p>
            </Card>
          )}
        </div>

        <Card className="h-fit p-5">
          <h2 className="text-lg font-bold">Get your ticket</h2>
          {!event.registrationOpen ? (
            <Notice tone={event.closedReason === "sold_out" ? "bad" : "neutral"} icon={Clock} className="mt-3">
              {event.closedReason === "sold_out"
                ? "This event is full. If a seat is released it will show here."
                : "This event has finished, so registration is closed."}
            </Notice>
          ) : (
            <form onSubmit={register} noValidate className="mt-4 space-y-4">
              <FormError message={formError} />
              <TextField label="Full name" autoComplete="name" value={values.name} onChange={set("name")} error={errors.name} required />
              <TextField
                label="Email"
                type="email"
                autoComplete="email"
                value={values.email}
                onChange={set("email")}
                error={errors.email}
                hint="One ticket per email address."
                required
              />
              <TextField label="Student ID" value={values.studentId} onChange={set("studentId")} error={errors.studentId} optional />
              {hasMemberPrice && (
                <TextField
                  label="Member number"
                  value={values.memberNo}
                  onChange={set("memberNo")}
                  error={errors.memberNo}
                  placeholder="SKY-M-0001"
                  optional
                  hint={
                    <>
                      Enter it with the email on your membership to pay <Money cents={event.memberPriceCents} /> instead of{" "}
                      <Money cents={event.priceCents} />.
                    </>
                  }
                />
              )}
              <Button type="submit" size="lg" className="w-full" loading={working}>
                {event.priceCents === 0 ? "Register" : "Reserve my ticket"}
              </Button>
              {event.priceCents > 0 && (
                <p className="text-[0.8125rem] text-muted">
                  No payment is taken on this site. Your seat is reserved now; pay a committee member before the event or at the door.
                </p>
              )}
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
