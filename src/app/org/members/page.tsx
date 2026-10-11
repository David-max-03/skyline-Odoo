"use client";

import { useSearchParams } from "next/navigation";
import { Banknote, Check, Search, UserPlus, Users } from "lucide-react";
import { Suspense, useMemo, useState, type FormEvent } from "react";
import { ApplicationsPanel, SetupLinkButton } from "@/components/applications-panel";
import { OnlinePaymentsPanel } from "@/components/online-payments-panel";
import { MEMBER_STATUS_LABELS, MemberStatusBadge, Money, OrderStatusBadge, PaymentBadge } from "@/components/domain";
import { Dialog, DialogActions, useToast } from "@/components/overlay";
import { useCan } from "@/components/session";
import {
  Badge,
  Button,
  Card,
  CheckboxField,
  EmptyState,
  ErrorState,
  FormError,
  LoadingBlock,
  PageHeader,
  Segmented,
  SelectField,
  Table,
  TableSkeleton,
  Td,
  TextField,
  Th,
} from "@/components/ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  SETTINGS,
  type Member,
  type MemberDetail,
  type MemberStatus,
} from "@/lib/contracts";
import { formatDate, formatShortDateTime } from "@/lib/dates";

type Filter = "all" | MemberStatus;
const FILTERS: Filter[] = ["all", "active", "expiring", "lapsed", "unpaid"];

function MembersList() {
  const toast = useToast();
  const params = useSearchParams();
  const canManage = useCan("manageMembers");
  const canAdd = useCan("addMembers");
  const { data, error, reload } = useApi<Member[]>("/api/members");

  const initial = params.get("status") as Filter | null;
  const [filter, setFilter] = useState<Filter>(initial && FILTERS.includes(initial) ? initial : "all");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data ?? []).filter(
      (m) =>
        (filter === "all" || m.status === filter) &&
        (!term || [m.name, m.email, m.memberNo, m.studentId ?? ""].some((v) => v.toLowerCase().includes(term))),
    );
  }, [data, filter, search]);

  const count = (f: Filter) => (data ?? []).filter((m) => f === "all" || m.status === f).length;

  async function act(member: Member, action: "renew" | "collect_dues") {
    setBusy(`${action}-${member.id}`);
    try {
      await api(`/api/members/${member.id}`, { method: "POST", body: { action, duesPaid: true, method: "cash" } });
      toast.success(action === "renew" ? `${member.name} renewed for another year. Dues recorded as collected.` : `Dues collected from ${member.name}.`);
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Members"
        description={`Who has joined, whether their dues are paid, and when their membership ends. Renewal is flagged ${SETTINGS.renewalReminderDays} days ahead.`}
        actions={
          canAdd && (
            <Button icon={UserPlus} onClick={() => setAdding(true)}>
              Add member
            </Button>
          )
        }
      />

      {canManage && <ApplicationsPanel onMemberCreated={reload} />}
      {canManage && <OnlinePaymentsPanel onMemberCreated={reload} />}

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Segmented
          label="Filter members"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({ value: f, label: f === "all" ? "All" : MEMBER_STATUS_LABELS[f], count: count(f) }))}
        />
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search members"
            aria-label="Search members"
            className="h-10 w-full rounded-control border border-line-strong bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
      </div>

      <Card>
        {error && !data ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : !data ? (
          <TableSkeleton label="Loading members" rows={6} />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={Users}
            title={data.length === 0 ? "No members yet" : "No members match"}
            description={data.length === 0 ? "Add the first member, or share the public Join page so people can apply." : "Try a different filter or search."}
          />
        ) : (
          <Table stack>
            <thead>
              <tr>
                <Th>Member</Th>
                <Th>Number</Th>
                <Th>Status</Th>
                <Th>Paid until</Th>
                <Th align="right">Dues owed</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((m) => (
                <tr key={m.id} className="transition-colors hover:bg-sunken/50">
                  <Td layout="lead">
                    <div className="flex items-center gap-3">
                      <span
                        aria-hidden
                        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-bold text-brand-deep"
                      >
                        {m.name
                          .split(" ")
                          .map((part) => part[0])
                          .slice(0, 2)
                          .join("")
                          .toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <button type="button" onClick={() => setViewing(m.id)} className="rounded text-left font-medium text-ink hover:text-brand hover:underline">
                          {m.name}
                        </button>
                        <div className="truncate text-[0.8125rem] text-muted">{m.email}</div>
                      </div>
                    </div>
                  </Td>
                  <Td label="Number" className="font-mono text-[0.8125rem]">
                    {m.memberNo}
                  </Td>
                  <Td label="Status">
                    <MemberStatusBadge status={m.status} />
                  </Td>
                  <Td label="Paid until">
                    {m.paidUntilOn ? (
                      <div>
                        {formatDate(m.paidUntilOn)}
                        {m.status === "expiring" && <div className="text-xs text-warn">in {m.daysToExpiry} days</div>}
                        {m.status === "lapsed" && <div className="text-xs text-bad">{Math.abs(m.daysToExpiry ?? 0)} days ago</div>}
                      </div>
                    ) : (
                      <span className="text-subtle">Never paid</span>
                    )}
                  </Td>
                  <Td label="Dues owed" align="right">
                    {m.duesOwedCents > 0 ? <Money cents={m.duesOwedCents} className="font-medium text-ink" /> : (
                      <span className="text-subtle">
                        <span aria-hidden className="max-sm:hidden">—</span>
                        <span className="sm:sr-only">Nothing</span>
                      </span>
                    )}
                  </Td>
                  <Td layout="actions">
                    {canManage && (
                      <div className="flex justify-end gap-1">
                        {m.duesOwedCents > 0 ? (
                          <Button size="sm" variant="secondary" icon={Banknote} loading={busy === `collect_dues-${m.id}`} onClick={() => act(m, "collect_dues")}>
                            Collect dues
                          </Button>
                        ) : (
                          (m.status === "expiring" || m.status === "lapsed") && (
                            <Button size="sm" variant="secondary" icon={Check} loading={busy === `renew-${m.id}`} onClick={() => act(m, "renew")}>
                              Renew
                            </Button>
                          )
                        )}
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {canAdd && (
        <Dialog open={adding} onClose={() => setAdding(false)} title="Add a member" description={`Annual dues are ${SETTINGS.membershipFeeCents / 100}. The term runs to 31 December.`}>
          {adding && (
            <AddMemberForm
              onCancel={() => setAdding(false)}
              onSaved={(member) => {
                setAdding(false);
                toast.success(`${member.name} added as ${member.memberNo}.`);
                reload();
              }}
            />
          )}
        </Dialog>
      )}

      <Dialog open={viewing !== null} onClose={() => setViewing(null)} title="Member record" size="lg">
        {viewing && <MemberRecord id={viewing} canManage={canManage} />}
      </Dialog>
    </>
  );
}

function AddMemberForm({ onSaved, onCancel }: { onSaved: (member: Member) => void; onCancel: () => void }) {
  const [values, setValues] = useState({ name: "", email: "", studentId: "", phone: "", method: "cash" });
  const [duesPaid, setDuesPaid] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const member = await api<Member>("/api/members", {
        method: "POST",
        body: { ...values, studentId: values.studentId || null, phone: values.phone || null, duesPaid },
      });
      onSaved(member);
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
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Full name" value={values.name} onChange={set("name")} error={errors.name} required autoFocus />
        <TextField label="Email" type="email" value={values.email} onChange={set("email")} error={errors.email} required />
        <TextField label="Student ID" value={values.studentId} onChange={set("studentId")} error={errors.studentId} optional />
        <TextField label="Phone" type="tel" value={values.phone} onChange={set("phone")} error={errors.phone} optional />
      </div>
      <CheckboxField
        label="Dues collected now"
        hint="Untick if they will pay later. The membership stays inactive until dues are collected."
        checked={duesPaid}
        onChange={(e) => setDuesPaid(e.target.checked)}
      />
      {duesPaid && (
        <SelectField label="Paid by" value={values.method} onChange={set("method")} className="max-w-48">
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {PAYMENT_METHOD_LABELS[m]}
            </option>
          ))}
        </SelectField>
      )}
      <DialogActions>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          Add member
        </Button>
      </DialogActions>
    </form>
  );
}

function MemberRecord({ id, canManage }: { id: string; canManage: boolean }) {
  const { data: m, error, reload } = useApi<MemberDetail>(`/api/members/${id}`);
  if (error && !m) return <ErrorState message={error.message} onRetry={reload} />;
  if (!m) return <LoadingBlock label="Loading member" />;

  return (
    <div className="space-y-6 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-display text-xl font-bold text-ink">{m.name}</p>
          <p className="text-muted">
            {m.email}
            {m.phone && ` · ${m.phone}`}
            {m.studentId && ` · Student ID ${m.studentId}`}
          </p>
          <p className="mt-1 font-mono text-[0.8125rem] text-ink">{m.memberNo}</p>
        </div>
        <MemberStatusBadge status={m.status} />
      </div>

      <section aria-labelledby="member-account" className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line px-3 py-2.5">
        <div>
          <h3 id="member-account" className="text-[0.9375rem] font-semibold">
            Member account
          </h3>
          <p className="text-muted">
            {m.hasAccount ? "Has set a password and can sign in." : "No password set yet. Send a setup link so they can sign in."}
          </p>
        </div>
        {canManage && <SetupLinkButton memberId={m.id} hasAccount={m.hasAccount} />}
      </section>

      <section aria-labelledby="terms">
        <h3 id="terms" className="mb-2 text-[0.9375rem] font-semibold">
          Membership history
        </h3>
        <ul className="divide-y divide-line rounded-control border border-line">
          {m.periods.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <span>
                <span className="font-medium text-ink">{p.kind === "new" ? "Joined" : "Renewed"}</span>{" "}
                <span className="text-muted">
                  {formatDate(p.startsOn)} to {formatDate(p.endsOn)}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <Money cents={p.amountCents} />
                {p.paidAt ? (
                  <Badge tone="ok" icon={Check}>
                    Paid {formatShortDateTime(p.paidAt)}
                  </Badge>
                ) : (
                  <Badge tone="warn">Unpaid</Badge>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="member-tickets">
        <h3 id="member-tickets" className="mb-2 text-[0.9375rem] font-semibold">
          Events ({m.tickets.length})
        </h3>
        {m.tickets.length === 0 ? (
          <p className="text-muted">No tickets under this email yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-control border border-line">
            {m.tickets.map((t) => (
              <li key={t.code} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <span>
                  <span className="font-medium text-ink">{t.eventTitle}</span>{" "}
                  <span className="text-muted">{formatShortDateTime(t.startsAt)}</span>
                </span>
                <span className="flex items-center gap-2">
                  {t.priceCents > 0 && <Money cents={t.priceCents} />}
                  {t.status === "cancelled" ? <Badge tone="bad">Cancelled</Badge> : <PaymentBadge status={t.paymentStatus} />}
                  {t.checkedInAt && <Badge tone="ok">Attended</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {m.orders.length > 0 && (
        <section aria-labelledby="member-orders">
          <h3 id="member-orders" className="mb-2 text-[0.9375rem] font-semibold">
            Merchandise ({m.orders.length})
          </h3>
          <ul className="divide-y divide-line rounded-control border border-line">
            {m.orders.map((o) => (
              <li key={o.code} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <span className="font-medium text-ink">
                  {o.quantity} × {o.productName} ({o.size})
                </span>
                <span className="flex items-center gap-2">
                  <Money cents={o.totalCents} />
                  <OrderStatusBadge status={o.status} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function MembersPage() {
  return (
    <Suspense fallback={<Card><LoadingBlock label="Loading members" /></Card>}>
      <MembersList />
    </Suspense>
  );
}
