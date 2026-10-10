"use client";

/**
 * Small display pieces that know Skyline's vocabulary: how an event status,
 * a payment or a membership is labelled and coloured. One place to change
 * wording or tone for the whole app.
 */

import { Check, Clock, type LucideIcon } from "lucide-react";
import {
  TASK_STATUS_LABELS,
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

/** A calendar tile: month over day, in the viewer's timezone. Decorative; the full date is always nearby in text. */
export function DateBlock({ iso, muted = false }: { iso: string; muted?: boolean }) {
  const date = new Date(iso);
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-12 shrink-0 flex-col items-center justify-center rounded-control border leading-none",
        muted ? "border-line bg-sunken text-muted" : "border-brand-line bg-brand-soft text-brand-deep",
      )}
    >
      <span className="text-[0.625rem] font-bold uppercase tracking-wider">
        {new Intl.DateTimeFormat("en", { month: "short" }).format(date)}
      </span>
      <span className="num mt-0.5 font-display text-lg font-extrabold">{date.getDate()}</span>
    </span>
  );
}

export const percent =(ratio: number | null) => (ratio === null ? "—" : `${Math.round(ratio * 100)}%`);
