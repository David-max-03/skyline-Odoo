"use client";

import { useState, type FormEvent } from "react";
import { api, errorMessage, fieldErrors } from "@/lib/api-client";
import {
  CATEGORY_LABELS,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type Transaction,
  type TransactionCategory,
  type TransactionType,
} from "@/lib/contracts";
import { CURRENCY, parseMoney, toInputAmount } from "@/lib/money";
import { DialogActions } from "./overlay";
import { Button, FormError, Notice, Segmented, SelectField, TextField } from "./ui";

const SYMBOL =
  new Intl.NumberFormat("en", { style: "currency", currency: CURRENCY }).formatToParts(0).find((p) => p.type === "currency")
    ?.value ?? "";

/** Today's date in the browser's timezone, as YYYY-MM-DD. */
export const localToday = () => new Date().toLocaleDateString("en-CA");

/**
 * Record or edit a ledger entry.
 *
 * `claimOnly` is the organizer's view: an expense claim that the treasurer
 * will settle. The server enforces the same rule regardless of this prop.
 */
export function TransactionForm({
  transaction,
  events,
  lockedEventId,
  claimOnly = false,
  defaultType = "expense",
  onSaved,
  onCancel,
}: {
  transaction?: Transaction;
  events: { id: string; title: string }[];
  /** When set, the entry is always linked to this event and the picker is hidden. */
  lockedEventId?: string;
  claimOnly?: boolean;
  defaultType?: TransactionType;
  onSaved: (transaction: Transaction) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<TransactionType>(claimOnly ? "expense" : (transaction?.type ?? defaultType));
  const [values, setValues] = useState({
    category: (transaction?.category ?? "") as TransactionCategory | "",
    amount: toInputAmount(transaction?.amountCents),
    occurredOn: transaction?.occurredOn ?? localToday(),
    description: transaction?.description ?? "",
    counterparty: transaction?.counterparty ?? "",
    status: claimOnly ? "pending" : (transaction?.status ?? "settled"),
    method: transaction?.method ?? "",
    eventId: lockedEventId ?? transaction?.eventId ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  const categories: readonly TransactionCategory[] = type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const category = (categories as readonly string[]).includes(values.category) ? values.category : "";
  const settled = values.status === "settled";

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amountCents = parseMoney(values.amount);
    const local: Record<string, string> = {};
    if (amountCents === null || amountCents === 0) local.amountCents = "Enter an amount greater than zero";
    if (!category) local.category = "Choose a category";
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) return;

    setSaving(true);
    try {
      const body = {
        type,
        category,
        amountCents,
        status: values.status,
        occurredOn: values.occurredOn,
        description: values.description,
        counterparty: values.counterparty || null,
        method: settled && values.method ? values.method : null,
        eventId: values.eventId || null,
      };
      const saved = transaction
        ? await api<Transaction>(`/api/transactions/${transaction.id}`, { method: "PATCH", body })
        : await api<Transaction>("/api/transactions", { method: "POST", body });
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
      {claimOnly ? (
        <Notice tone="brand">
          This files an expense claim. It shows as <strong>to pay</strong> until the treasurer settles it.
        </Notice>
      ) : (
        <Segmented
          label="Entry type"
          value={type}
          onChange={setType}
          options={[
            { value: "expense", label: "Money out" },
            { value: "income", label: "Money in" },
          ]}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Category" value={category} onChange={set("category")} error={errors.category} required>
          <option value="">Choose…</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </SelectField>
        <TextField label="Amount" prefix={SYMBOL} inputMode="decimal" value={values.amount} onChange={set("amount")} error={errors.amountCents} required />
      </div>
      <TextField
        label="What was it for?"
        value={values.description}
        onChange={set("description")}
        error={errors.description}
        placeholder={type === "income" ? "Sponsorship from Campus Café" : "Hall booking fee"}
        required
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={type === "income" ? "Received from" : "Paid to"}
          value={values.counterparty}
          onChange={set("counterparty")}
          error={errors.counterparty}
          optional
        />
        <TextField label="Date" type="date" value={values.occurredOn} onChange={set("occurredOn")} error={errors.occurredOn} required />
      </div>
      {!claimOnly && (
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Status"
            value={values.status}
            onChange={set("status")}
            error={errors.status}
            hint={settled ? "Counts toward the balance." : "Tracked separately until it settles."}
          >
            <option value="settled">{type === "income" ? "Collected" : "Paid"}</option>
            <option value="pending">{type === "income" ? "Not collected yet" : "Not paid yet"}</option>
          </SelectField>
          {settled && (
            <SelectField label="Method" value={values.method} onChange={set("method")} error={errors.method} optional>
              <option value="">Not recorded</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </SelectField>
          )}
        </div>
      )}
      {!lockedEventId && (
        <SelectField label="Event" value={values.eventId} onChange={set("eventId")} error={errors.eventId} optional hint="Link it so the event's result is accurate.">
          <option value="">Not tied to an event</option>
          {events.map((event) => (
            <option key={event.id} value={event.id}>
              {event.title}
            </option>
          ))}
        </SelectField>
      )}
      <DialogActions>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          {transaction ? "Save changes" : claimOnly ? "File claim" : "Record entry"}
        </Button>
      </DialogActions>
    </form>
  );
}
