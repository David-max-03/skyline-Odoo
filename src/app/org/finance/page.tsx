"use client";

import { useSearchParams } from "next/navigation";
import { ArrowDownLeft, ArrowUpRight, Check, Equal, Minus, Pencil, Plus, Wallet } from "lucide-react";
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
  PageHeader,
  SelectField,
  Skeleton,
  StatSkeleton,
  Table,
  TableSkeleton,
  Td,
  TextField,
  Th,
  cn,
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
        <div className="mb-6 space-y-5">
          <Skeleton className="h-56 !rounded-card" />
          <StatSkeleton count={2} />
        </div>
      ) : (
        <>
          {/* The statement: what came in, what went out, what is left. Read left to right. */}
          <Card aria-labelledby="statement-heading" className="overflow-hidden">
            <h2 id="statement-heading" className="sr-only">
              Statement
            </h2>
            <div className="grid items-stretch md:grid-cols-[1fr_auto_1fr_auto_1.15fr]">
              <div className="p-5 sm:p-6">
                <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-muted">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-ok-soft text-ok-strong">
                    <ArrowDownLeft className="size-4" aria-hidden />
                  </span>
                  Collected
                </p>
                <p className="num mt-3 font-display text-[1.75rem] font-bold leading-none text-ink">
                  <Money cents={s.incomeSettledCents} />
                </p>
                <p className="mt-2 text-[0.8125rem] text-muted">Income actually received</p>
              </div>
              <div className="hidden items-center text-subtle md:flex" aria-hidden>
                <Minus className="size-5" />
              </div>
              <div className="border-t border-line p-5 sm:p-6 md:border-t-0">
                <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-muted">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-sunken text-body">
                    <ArrowUpRight className="size-4" aria-hidden />
                  </span>
                  Paid out
                </p>
                <p className="num mt-3 font-display text-[1.75rem] font-bold leading-none text-ink">
                  <Money cents={s.expenseSettledCents} />
                </p>
                <p className="mt-2 text-[0.8125rem] text-muted">Expenses actually paid</p>
              </div>
              <div className="hidden items-center pr-5 text-subtle md:flex" aria-hidden>
                <Equal className="size-5" />
              </div>
              <div className="bg-night p-5 sm:p-6">
                <p className="flex items-center gap-2 text-[0.8125rem] font-semibold uppercase tracking-wider text-on-night-muted">
                  <Wallet className="size-4 text-accent" aria-hidden />
                  What is left
                </p>
                <p className="num mt-3 font-display text-[2.25rem] font-extrabold leading-none text-white">
                  <Money cents={s.netCents} />
                </p>
                <p className="mt-2 text-[0.8125rem] text-on-night-muted">Collected minus paid out. Pending items are not counted.</p>
              </div>
            </div>
            <dl className="grid gap-px border-t border-line bg-line sm:grid-cols-3">
              <div className="bg-surface px-5 py-4 sm:px-6">
                <dt className="text-[0.8125rem] font-medium text-muted">Still to collect</dt>
                <dd className="num mt-1 font-display text-xl font-bold text-ink">
                  <Money cents={s.incomePendingCents} />
                </dd>
              </div>
              <div className="bg-surface px-5 py-4 sm:px-6">
                <dt className="text-[0.8125rem] font-medium text-muted">Still to pay</dt>
                <dd className="num mt-1 font-display text-xl font-bold text-ink">
                  <Money cents={s.expensePendingCents} />
                </dd>
              </div>
              <div className="bg-surface px-5 py-4 sm:px-6">
                <dt className="flex items-center gap-2 text-[0.8125rem] font-medium text-muted">
                  If every pending item settles <Badge tone="warn">Estimate</Badge>
                </dt>
                <dd className="num mt-1 font-display text-xl font-bold text-ink">
                  <Money cents={s.projectedNetCents} />
                </dd>
              </div>
            </dl>
          </Card>

          <div className="mt-5 grid gap-5 xl:grid-cols-5">
            <Card className="xl:col-span-2">
              <CardHeader title="By month" description="Collected and paid amounts only." />
              <div className="p-5">
                {s.byMonth.length === 0 ? <EmptyState icon={Wallet} title="Nothing settled yet" /> : <CashflowChart months={s.byMonth} />}
              </div>
            </Card>
            <Card className="xl:col-span-3">
              <CardHeader title="Where the money came from and went" description="Settled amounts by category. Anything still pending is noted beside it." />
              {s.byCategory.length === 0 ? (
                <EmptyState icon={Wallet} title="No entries yet" />
              ) : (
                <div className="grid gap-x-8 gap-y-6 p-5 md:grid-cols-2">
                  <CategoryBars title="Money in" rows={s.byCategory.filter((c) => c.type === "income")} color="var(--chart-1)" />
                  <CategoryBars title="Money out" rows={s.byCategory.filter((c) => c.type === "expense")} color="var(--chart-2)" />
                </div>
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
          <TableSkeleton label="Loading ledger" rows={6} />
        ) : ledger.data.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title={query ? "No entries match these filters" : "The ledger is empty"}
            description={query ? "Clear a filter to see more." : "Record the opening balance, dues collected, or your first expense."}
          />
        ) : (
          <>
            <Table stack>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Entry</Th>
                  <Th>Category</Th>
                  <Th>Status</Th>
                  <Th align="right">Amount</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {ledger.data.map((t) => (
                  <tr key={t.id} className="transition-colors hover:bg-sunken/50">
                    <Td label="Date" className="whitespace-nowrap text-muted">
                      {formatDate(t.occurredOn)}
                    </Td>
                    <Td layout="lead" className="sm:max-w-xs max-sm:order-first">
                      <div className="font-medium text-ink">{t.description}</div>
                      <div className="text-[0.8125rem] text-muted">
                        {[t.counterparty, t.eventTitle, SOURCE_LABELS[t.source]].filter(Boolean).join(" · ")}
                      </div>
                    </Td>
                    <Td label="Category" className="text-muted">
                      {CATEGORY_LABELS[t.category]}
                    </Td>
                    <Td label="Status">
                      <TransactionStatusBadge type={t.type} status={t.status} />
                    </Td>
                    <Td label="Amount" align="right">
                      <Money
                        cents={t.type === "income" ? t.amountCents : -t.amountCents}
                        signed
                        className={cn("font-semibold", t.type === "income" ? "text-ok-strong" : "text-ink")}
                      />
                    </Td>
                    <Td layout="actions">
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

/**
 * One direction of the category breakdown as labelled bars. Bar length shows
 * each category's share of the largest one; the amounts are always in text.
 */
function CategoryBars({
  title,
  rows,
  color,
}: {
  title: string;
  rows: FinanceSummary["byCategory"];
  color: string;
}) {
  // Longest bar first, so the list reads as a ranking. Display order only.
  rows = rows.toSorted((a, b) => b.settledCents - a.settledCents);
  const largest = Math.max(1, ...rows.map((r) => r.settledCents));
  return (
    <section aria-label={title}>
      <h3 className="mb-3 flex items-center gap-2 text-[0.8125rem] font-semibold uppercase tracking-wide !text-muted">
        <span className="size-2.5 rounded-sm" style={{ background: color }} aria-hidden />
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing recorded.</p>
      ) : (
        <ul className="space-y-3.5">
          {rows.map((row) => (
            <li key={row.category}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate font-medium text-ink">{CATEGORY_LABELS[row.category]}</span>
                <Money cents={row.settledCents} className="font-semibold text-ink" />
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-sunken" aria-hidden>
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(row.settledCents > 0 ? 2 : 0, (row.settledCents / largest) * 100)}%`, background: color }}
                />
              </div>
              <p className="mt-1 text-xs text-muted">
                {row.count} {row.count === 1 ? "entry" : "entries"}
                {row.pendingCents > 0 && (
                  <>
                    {" · "}
                    <Money cents={row.pendingCents} /> pending
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function FinancePage() {
  return (
    <Suspense fallback={<Card><LoadingBlock label="Loading finance" /></Card>}>
      <FinanceLedger />
    </Suspense>
  );
}
