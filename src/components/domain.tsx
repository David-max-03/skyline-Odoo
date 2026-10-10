"use client";

/**
 * Small display pieces that know Skyline's vocabulary: how an event status,
 * a payment or a membership is labelled and coloured. One place to change
 * wording or tone for the whole app.
 */

import { Check, CircleAlert, Clock, Lightbulb, type LucideIcon } from "lucide-react";
import {
  TASK_STATUS_LABELS,
  type AssistantFactKind,
  type EventPhase,
  type EventStatus,
  type MemberStatus,
  type OrderStatus,
  type TaskStatus,
  type TicketPaymentStatus,
  type TransactionStatus,
  type TransactionType,
} from "@/lib/contracts";
import { formatMoney } from "@/lib/money";
import { Badge, cn, type Tone } from "./ui";

export function Money({
  cents,
  signed = false,
  colored = false,
  className,
}: {
  cents: number;
  signed?: boolean;
  /** Green when positive, red when negative. Use for results, not plain amounts. */
  colored?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "num whitespace-nowrap",
        colored && cents > 0 && "text-ok",
        colored && cents < 0 && "text-bad",
        className,
      )}
    >
      {formatMoney(cents, { signed })}
    </span>
  );
}

export function EventStatusBadge({ status, phase }: { status: EventStatus; phase: EventPhase }) {
  if (status === "draft") return <Badge>Draft</Badge>;
  if (status === "cancelled") return <Badge tone="bad">Cancelled</Badge>;
  if (phase === "live") return <Badge tone="ok">Happening now</Badge>;
  if (phase === "past") return <Badge>Finished</Badge>;
  return <Badge tone="brand">On sale</Badge>;
}

const PAYMENT: Record<TicketPaymentStatus, { label: string; tone: Tone; icon?: LucideIcon }> = {
  paid: { label: "Paid", tone: "ok", icon: Check },
  pending: { label: "Unpaid", tone: "warn", icon: Clock },
  free: { label: "Free", tone: "neutral" },
};

export function PaymentBadge({ status }: { status: TicketPaymentStatus }) {
  const p = PAYMENT[status];
  return (
    <Badge tone={p.tone} icon={p.icon}>
      {p.label}
    </Badge>
  );
}

/** Ledger status in the words a treasurer uses: collected / to collect, paid / to pay. */
export function TransactionStatusBadge({ type, status }: { type: TransactionType; status: TransactionStatus }) {
  if (status === "settled") {
    return (
      <Badge tone="ok" icon={Check}>
        {type === "income" ? "Collected" : "Paid"}
      </Badge>
    );
  }
  return (
    <Badge tone="warn" icon={Clock}>
      {type === "income" ? "To collect" : "To pay"}
    </Badge>
  );
}

const MEMBER: Record<MemberStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "ok" },
  expiring: { label: "Renewal due", tone: "warn" },
  lapsed: { label: "Lapsed", tone: "bad" },
  unpaid: { label: "Dues unpaid", tone: "neutral" },
};

export function MemberStatusBadge({ status }: { status: MemberStatus }) {
  return <Badge tone={MEMBER[status].tone}>{MEMBER[status].label}</Badge>;
}

export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  active: MEMBER.active.label,
  expiring: MEMBER.expiring.label,
  lapsed: MEMBER.lapsed.label,
  unpaid: MEMBER.unpaid.label,
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const tone: Tone = status === "done" ? "ok" : status === "in_progress" ? "brand" : "neutral";
  return <Badge tone={tone}>{TASK_STATUS_LABELS[status]}</Badge>;
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  if (status === "fulfilled") return <Badge tone="ok">Handed over</Badge>;
  if (status === "cancelled") return <Badge tone="bad">Cancelled</Badge>;
  return <Badge tone="brand">To hand over</Badge>;
}

const FACT: Record<AssistantFactKind, { label: string; tone: Tone; icon: LucideIcon; title: string }> = {
  actual: { label: "Actual", tone: "ok", icon: Check, title: "Read directly from stored records" },
  estimate: { label: "Estimate", tone: "warn", icon: CircleAlert, title: "Calculated from records plus a stated assumption" },
  recommendation: { label: "Suggestion", tone: "brand", icon: Lightbulb, title: "A suggested action, not a fact" },
};

export function FactKindBadge({ kind }: { kind: AssistantFactKind }) {
  const f = FACT[kind];
  return (
    <span title={f.title}>
      <Badge tone={f.tone} icon={f.icon}>
        {f.label}
      </Badge>
    </span>
  );
}

export const percent = (ratio: number | null) => (ratio === null ? "—" : `${Math.round(ratio * 100)}%`);
