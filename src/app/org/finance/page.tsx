"use client";

import { useSearchParams } from "next/navigation";
import { Check, Pencil, Plus, Wallet } from "lucide-react";
import { Suspense, useMemo, useState, type FormEvent } from "react";
import { CashflowChart } from "@/components/charts";
import { Money, TransactionStatusBadge } from "@/components/domain";
import { Dialog, DialogActions, useToast } from "@/components/overlay";
import { useCan } from "@/components/session";
import { TransactionForm } from "@/components/transaction-form";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  FormError,
  LoadingBlock,
  Notice,
  PageHeader,
  SelectField,
  Stat,
  Table,
  Td,
  TextField,
  Th,
} from "@/components/ui";
import { api, errorMessage, useApi } from "@/lib/api-client";
import {
  CATEGORY_LABELS,
  type EventSummary,
  type FinanceSummary,
  type Transaction,
} from "@/lib/contracts";
import { formatDate } from "@/lib/dates";

const SOURCE_LABELS: Record<Transaction["source"], string | null> = {
  manual: null,
  ticket: "From a ticket",
  dues: "From a membership",
  order: "From a merchandise order",
  refund: "Refund owed",
};

function FinanceLedger() {
  const toast = useToast();
  const params = useSearchParams();
  const canManage = useCan("manageFinance");

  const [type, setType] = useState(params.get("type") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [eventId, setEventId] = useState(params.get("eventId") ?? "");

  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (type) q.set("type", type);
    if (status) q.set("status", status);
    if (eventId) q.set("eventId", eventId);
    return q.toString();
  }, [type, status, eventId]);

  const summary = useApi<FinanceSummary>("/api/finance/summary");
  const ledger = useApi<Transaction[]>(`/api/transactions${query ? `?${query}` : ""}`);
  const events = useApi<EventSummary[]>("/api/events");

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [voiding, setVoiding] = useState<Transaction | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidError, setVoidError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reloadAll = () => {
    summary.reload();
    ledger.reload();
  };
  const eventOptions = (events.data ?? []).map((e) => ({ id: e.id, title: e.title }));

  async function settle(t: Transaction) {
    setBusy(t.id);
    try {
      await api(`/api/transactions/${t.id}`, { method: "POST", body: { action: "settle", method: null } });
      toast.success(t.type === "income" ? "Marked as collected." : "Marked as paid.");
      reloadAll();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function submitVoid(e: FormEvent) {
    e.preventDefault();
    if (!voiding) return;
    setBusy(voiding.id);
    setVoidError(null);
    try {
      await api(`/api/transactions/${voiding.id}`, { method: "POST", body: { action: "void", reason: voidReason } });
      toast.success("Entry voided. It no longer counts toward any total.");
      setVoiding(null);
      setVoidReason("");
      reloadAll();
    } catch (error) {
      setVoidError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const s = summary.data;

  return (
    <>
      <PageHeader
        title="Finance"
        description="One ledger for everything that comes in and goes out. Collected and paid amounts make up the balance; anything still pending is shown separately."
        actions={
          <Button icon={Plus} onClick={() => setAdding(true)}>
            {canManage ? "Record entry" : "File expense claim"}
          </Button>
        }
      />

      {summary.error && !s ? (
        <Card className="mb-6">
          <ErrorState message={summary.error.message} onRetry={summary.reload} />
        </Card>
      ) : !s ? (
        <Card className="mb-6">
          <LoadingBlock label="Loading totals" rows={2} />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Collected" tone="ok" icon={Wallet} value={<Money cents={s.incomeSettledCents} />} detail="Income actually received" />
            <Stat label="Paid out" tone="neutral" icon={Wallet} value={<Money cents={s.expenseSettledCents} />} detail="Expenses actually paid" />
            <Stat
              label="What is left"
              tone={s.netCents < 0 ? "bad" : "brand"}
              icon={Wallet}
              value={<Money cents={s.netCents} />}
              detail="Collected − paid out"
            />
            <Stat
              label="Pending"
              tone="warn"
              icon={Wallet}
              value={<Money cents={s.incomePendingCents - s.expensePendingCents} signed />}
              detail={
                <>
                  <Money cents={s.incomePendingCents} /> to collect · <Money cents={s.expensePendingCents} /> to pay
                </>
              }
            />
          </div>
          <Notice tone="neutral" className="mt-3">
            If every pending item settles as recorded, the balance would be <Money cents={s.projectedNetCents} className="font-semibold text-ink" />. <Badge tone="warn">Estimate</Badge>
          </Notice>

          <div className="mt-6 grid gap-4 xl:grid-cols-5">
            <Card className="xl:col-span-2">
              <CardHeader title="By month" description="Collected and paid amounts only." />
              <div className="p-5">
                {s.byMonth.length === 0 ? <EmptyState icon={Wallet} title="Nothing settled yet" /> : <CashflowChart months={s.byMonth} />}
              </div>
            </Card>
            <Card className="xl:col-span-3">
              <CardHeader title="Where the money came from and went" description="By category. Pending amounts are listed beside the settled ones." />
              {s.byCategory.length === 0 ? (
                <EmptyState icon={Wallet} title="No entries yet" />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Category</Th>
                      <Th align="right">Entries</Th>
                      <Th align="right">Settled</Th>
                      <Th align="right">Pending</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byCategory.map((c) => (
                      <tr key={`${c.type}-${c.category}`}>
                        <Td>
                          <span className="font-medium text-ink">{CATEGORY_LABELS[c.category]}</span>{" "}
                          <span className="text-xs text-muted">{c.type === "income" ? "in" : "out"}</span>
                        </Td>
                        <Td align="right">{c.count}</Td>
                        <Td align="right">
                          <Money cents={c.type === "income" ? c.settledCents : -c.settledCents} signed />
                        </Td>
                        <Td align="right" className="text-muted">
                          {c.pendingCents === 0 ? "—" : <Money cents={c.pendingCents} />}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
        </>
      )}

      <Card className="mt-6">
        <CardHeader title="Ledger" description="Every entry, newest first. Entries created by tickets, orders and memberships follow those records." />
        <div className="grid gap-3 border-b border-line px-5 py-4 sm:grid-cols-3">
          <SelectField label="Direction" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Money in and out</option>
            <option value="income">Money in</option>
            <option value="expense">Money out</option>
          </SelectField>
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Settled and pending</option>
            <option value="settled">Settled</option>
            <option value="pending">Pending</option>
          </SelectField>
          <SelectField label="Event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">All</option>
            <option value="none">Not tied to an event</option>
            {eventOptions.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </SelectField>
        </div>
        {ledger.error && !ledger.data ? (
          <ErrorState message={ledger.error.message} onRetry={ledger.reload} />
        ) : !ledger.data ? (
          <LoadingBlock label="Loading ledger" rows={6} />
        ) : ledger.data.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title={query ? "No entries match these filters" : "The ledger is empty"}
            description={query ? "Clear a filter to see more." : "Record the opening balance, dues collected, or your first expense."}
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Entry</Th>
                  <Th>Category</Th>
                  <Th>Status</Th>
                  <Th align="right">Amount</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {ledger.data.map((t) => (
                  <tr key={t.id} className="hover:bg-sunken/50">
                    <Td className="whitespace-nowrap text-muted">{formatDate(t.occurredOn)}</Td>
                    <Td className="max-w-xs">
                      <div className="font-medium text-ink">{t.description}</div>
                      <div className="text-[0.8125rem] text-muted">
                        {[t.counterparty, t.eventTitle, SOURCE_LABELS[t.source]].filter(Boolean).join(" · ")}
                      </div>
                    </Td>
                    <Td className="text-muted">{CATEGORY_LABELS[t.category]}</Td>
                    <Td>
                      <TransactionStatusBadge type={t.type} status={t.status} />
                    </Td>
                    <Td align="right">
                      <Money cents={t.type === "income" ? t.amountCents : -t.amountCents} signed className="font-medium text-ink" />
                    </Td>
                    <Td>
                      {canManage && (
                        <div className="flex justify-end gap-1">
                          {t.status === "pending" && (
                            <Button size="sm" variant="secondary" icon={Check} loading={busy === t.id} onClick={() => settle(t)}>
                              {t.type === "income" ? "Collected" : "Paid"}
                            </Button>
                          )}
                          {t.source === "manual" && (
                            <Button size="sm" variant="ghost" icon={Pencil} aria-label={`Edit ${t.description}`} onClick={() => setEditing(t)} />
                          )}
                          {(t.source === "manual" || t.source === "refund") && (
                            <Button size="sm" variant="ghost" onClick={() => { setVoiding(t); setVoidError(null); }}>
                              Void
                            </Button>
                          )}
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="px-5 py-3 text-[0.8125rem] text-muted">
              {ledger.data.length} {ledger.data.length === 1 ? "entry" : "entries"} shown · settled total{" "}
              <Money
                cents={ledger.data.filter((t) => t.status === "settled").reduce((sum, t) => sum + (t.type === "income" ? t.amountCents : -t.amountCents), 0)}
                signed
                className="font-medium text-ink"
              />
            </p>
          </>
        )}
      </Card>

      <Dialog open={adding} onClose={() => setAdding(false)} title={canManage ? "Record an entry" : "File an expense claim"}>
        {adding && (
          <TransactionForm
            events={eventOptions}
            claimOnly={!canManage}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              toast.success(canManage ? "Entry recorded." : "Claim filed for the treasurer.");
              reloadAll();
            }}
          />
        )}
      </Dialog>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title="Edit entry">
        {editing && (
          <TransactionForm
            key={editing.id}
            transaction={editing}
            events={eventOptions}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              toast.success("Entry updated.");
              reloadAll();
            }}
          />
        )}
      </Dialog>

      <Dialog
        open={voiding !== null}
        onClose={() => setVoiding(null)}
        title="Void this entry?"
        description="It stays in the database with your reason but stops counting toward every total."
        size="sm"
      >
        {voiding && (
          <form onSubmit={submitVoid} className="space-y-4">
            <FormError message={voidError} />
            <p className="text-sm">
              <span className="font-medium text-ink">{voiding.description}</span> · <Money cents={voiding.amountCents} />
            </p>
            <TextField label="Reason" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Entered twice" required autoFocus />
            <DialogActions>
              <Button variant="secondary" onClick={() => setVoiding(null)}>
                Keep entry
              </Button>
              <Button type="submit" variant="danger" loading={busy === voiding.id}>
                Void entry
              </Button>
            </DialogActions>
          </form>
        )}
      </Dialog>
    </>
  );
}

export default function FinancePage() {
  return (
    <Suspense fallback={<Card><LoadingBlock label="Loading finance" /></Card>}>
      <FinanceLedger />
    </Suspense>
  );
}
