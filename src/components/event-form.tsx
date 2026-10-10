"use client";

import { useState, type FormEvent } from "react";
import { api, errorMessage, fieldErrors } from "@/lib/api-client";
import type { EventSummary } from "@/lib/contracts";
import { fromLocalInputValue, toLocalInputValue } from "@/lib/dates";
import { CURRENCY, parseMoney, toInputAmount } from "@/lib/money";
import { DialogActions } from "./overlay";
import { Button, FormError, TextAreaField, TextField } from "./ui";

const SYMBOL =
  new Intl.NumberFormat("en", { style: "currency", currency: CURRENCY }).formatToParts(0).find((p) => p.type === "currency")
    ?.value ?? "";

/** Create or edit an event. The server validates; this only shapes the input. */
export function EventForm({
  event,
  onSaved,
  onCancel,
}: {
  event?: EventSummary;
  onSaved: (event: EventSummary) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState({
    title: event?.title ?? "",
    description: event?.description ?? "",
    venue: event?.venue ?? "",
    startsAt: toLocalInputValue(event?.startsAt),
    endsAt: toLocalInputValue(event?.endsAt),
    capacity: event ? String(event.capacity) : "",
    price: event ? toInputAmount(event.priceCents) : "",
    memberPrice: event ? toInputAmount(event.memberPriceCents) : "",
    profitTarget: toInputAmount(event?.profitTargetCents),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    const startsAt = fromLocalInputValue(values.startsAt);
    const endsAt = fromLocalInputValue(values.endsAt);
    if (!startsAt) local.startsAt = "Choose when the event starts";
    if (!endsAt) local.endsAt = "Choose when the event ends";
    const capacity = Number(values.capacity);
    if (!values.capacity.trim() || !Number.isInteger(capacity)) local.capacity = "Enter a whole number of seats";
    const priceCents = parseMoney(values.price || "0");
    if (priceCents === null) local.priceCents = "Enter an amount such as 250 or 249.50";
    // An empty member price means members pay the same as everyone else.
    const memberPriceCents = values.memberPrice.trim() ? parseMoney(values.memberPrice) : priceCents;
    if (memberPriceCents === null) local.memberPriceCents = "Enter an amount such as 200";
    const profitTargetCents = values.profitTarget.trim() ? parseMoney(values.profitTarget) : null;
    if (values.profitTarget.trim() && profitTargetCents === null) local.profitTargetCents = "Enter an amount such as 5000";

    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) return;

    setSaving(true);
    try {
      const body = {
        title: values.title,
        description: values.description,
        venue: values.venue,
        startsAt,
        endsAt,
        capacity,
        priceCents,
        memberPriceCents,
        profitTargetCents,
      };
      const saved = event
        ? await api<EventSummary>(`/api/events/${event.id}`, { method: "PATCH", body })
        : await api<EventSummary>("/api/events", { method: "POST", body });
      onSaved(saved);
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <FormError message={formError} />
      <TextField label="Event name" value={values.title} onChange={set("title")} error={errors.title} placeholder="Spring Gala" required autoFocus={!event} />
      <TextField label="Venue" value={values.venue} onChange={set("venue")} error={errors.venue} placeholder="Student Centre, Hall B" required />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Starts" type="datetime-local" value={values.startsAt} onChange={set("startsAt")} error={errors.startsAt} required />
        <TextField label="Ends" type="datetime-local" value={values.endsAt} onChange={set("endsAt")} error={errors.endsAt} required />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Seats"
          inputMode="numeric"
          value={values.capacity}
          onChange={set("capacity")}
          error={errors.capacity}
          hint={event && event.stats.registered > 0 ? `${event.stats.registered} already registered` : undefined}
          required
        />
        <TextField label="Ticket price" prefix={SYMBOL} inputMode="decimal" value={values.price} onChange={set("price")} error={errors.priceCents} hint="0 for a free event" />
        <TextField label="Member price" prefix={SYMBOL} inputMode="decimal" value={values.memberPrice} onChange={set("memberPrice")} error={errors.memberPriceCents} optional hint="Blank = same as ticket price" />
      </div>
      <TextField
        label="Profit target"
        prefix={SYMBOL}
        inputMode="decimal"
        value={values.profitTarget}
        onChange={set("profitTarget")}
        error={errors.profitTargetCents}
        optional
        hint="Used to show how far the event is from its goal."
      />
      <TextAreaField label="Description" value={values.description} onChange={set("description")} error={errors.description} optional placeholder="What should people know before they register?" />
      <DialogActions>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          {event ? "Save changes" : "Create draft"}
        </Button>
      </DialogActions>
    </form>
  );
}
