"use client";

import { Check, Wallet } from "lucide-react";
import { MemberStatusBadge, Money } from "@/components/domain";
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api-client";
import { SETTINGS, type MemberDetail, type MemberPayment } from "@/lib/contracts";
import { formatDate, formatShortDateTime } from "@/lib/dates";

const STATUS_LINE: Record<MemberDetail["status"], string> = {
  active: "Your membership is active. Member prices apply to tickets and merchandise.",
  expiring: "Your membership is active but ends soon. Renew with the treasurer to keep member prices.",
  lapsed: "Your membership has expired. Member prices are paused until you renew with the treasurer.",
  unpaid: "Your membership is pending: dues have not been collected yet, so member prices do not apply.",
};

export default function MembershipPage() {
  const me = useApi<MemberDetail>("/api/me");
  const payments = useApi<MemberPayment[]>("/api/me/payments");

  if (me.error && !me.data) {
    return (
      <Card>
        <ErrorState message={me.error.message} onRetry={me.reload} />
      </Card>
    );
  }
  if (!me.data) {
    return (
      <Card>
        <LoadingBlock label="Loading your membership" />
      </Card>
    );
  }
  const m = me.data;

  return (
    <>
      <PageHeader title="My membership" description={`Annual dues are ${SETTINGS.membershipFeeCents / 100} and each term runs to 31 December.`} />

      <Card className="mb-6 p-5">
        <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted">Member ID</dt>
            <dd className="font-mono text-lg font-bold text-ink">{m.memberNo}</dd>
          </div>
          <div>
            <dt className="text-muted">Status</dt>
            <dd className="mt-0.5">
              <MemberStatusBadge status={m.status} />
            </dd>
          </div>
          <div>
            <dt className="text-muted">Member since</dt>
            <dd className="font-semibold text-ink">{formatDate(m.joinedOn)}</dd>
          </div>
          <div>
            <dt className="text-muted">{m.status === "lapsed" ? "Expired on" : "Paid until"}</dt>
            <dd className="font-semibold text-ink">
              {m.paidUntilOn ? formatDate(m.paidUntilOn) : "Not paid"}
              {m.status === "expiring" && <span className="block text-xs font-normal text-warn">in {m.daysToExpiry} days</span>}
            </dd>
          </div>
        </dl>
        <Notice tone={m.status === "active" ? "ok" : m.status === "expiring" ? "warn" : "bad"} className="mt-5">
          {STATUS_LINE[m.status]}
          {m.duesOwedCents > 0 && (
            <>
              {" "}
              Dues owed: <Money cents={m.duesOwedCents} />.
            </>
          )}
        </Notice>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Terms" description="Each year you have been a member." />
          <ul className="divide-y divide-line text-sm">
            {m.periods.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
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
        </Card>

        <Card>
          <CardHeader title="My payments" description="What the club has recorded for you. Unpaid items are still owed." />
          {payments.error && !payments.data ? (
            <ErrorState message={payments.error.message} onRetry={payments.reload} />
          ) : !payments.data ? (
            <LoadingBlock label="Loading payments" rows={3} />
          ) : payments.data.length === 0 ? (
            <EmptyState icon={Wallet} title="Nothing recorded yet" />
          ) : (
            <ul className="divide-y divide-line text-sm">
              {payments.data.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <span className="min-w-0">
                    <span className="block text-ink">{p.description}</span>
                    <span className="block text-[0.8125rem] text-muted">
                      {formatDate(p.occurredOn)}
                      {p.type === "expense" && " · paid to you"}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Money cents={p.amountCents} />
                    {p.status === "settled" ? <Badge tone="ok">{p.type === "expense" ? "Repaid" : "Paid"}</Badge> : <Badge tone="warn">{p.type === "expense" ? "Owed to you" : "Unpaid"}</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
