import { SETTINGS, type Dashboard, type DashboardAlert } from "@/lib/contracts";
import { formatMoney } from "@/lib/money";
import { all, get, nowIso } from "../db";
import { listEvents } from "./events";
import { getFinanceTotals, getMonthlyCashflow } from "./finance";
import { memberCounts } from "./members";
import { listTasks } from "./tasks";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Everything the dashboard shows, computed from stored records in one call. */
export function getDashboard(): Dashboard {
  const events = listEvents();
  const live = events.filter((e) => e.status !== "cancelled");
  const members = memberCounts();
  const finance = getFinanceTotals();
  const tasks = listTasks();

  const upcoming = live
    .filter((e) => e.status === "published" && e.phase !== "past")
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const ticketTotals = live.reduce(
    (t, e) => {
      t.registered += e.stats.registered;
      t.paid += e.stats.paid;
      t.pending += e.stats.pending;
      t.free += e.stats.free;
      t.checkedIn += e.stats.checkedIn;
      if (e.phase !== "upcoming") {
        t.startedRegistered += e.stats.registered;
        t.startedCheckedIn += e.stats.checkedIn;
      }
      return t;
    },
    { registered: 0, paid: 0, pending: 0, free: 0, checkedIn: 0, startedRegistered: 0, startedCheckedIn: 0 },
  );

  const overdue = tasks.filter((t) => t.isOverdue);
  const alerts: DashboardAlert[] = [];

  if (overdue.length > 0) {
    alerts.push({
      kind: "overdue_tasks",
      severity: "warning",
      title: `${plural(overdue.length, "volunteer task")} overdue`,
      detail: overdue
        .slice(0, 2)
        .map((t) => `${t.title}${t.assignee ? ` (${t.assignee})` : ""}`)
        .join("; "),
      href: "/org/tasks",
    });
  }

  const claims = get<{ n: number; total: number | null }>(
    `SELECT COUNT(*) AS n, SUM(amount_cents) AS total FROM transactions
     WHERE voided_at IS NULL AND type = 'expense' AND status = 'pending' AND source = 'manual'`,
  )!;
  if (claims.n > 0) {
    alerts.push({
      kind: "pending_reimbursements",
      severity: "warning",
      title: `${plural(claims.n, "expense")} waiting to be paid`,
      detail: `${formatMoney(claims.total ?? 0)} is owed to volunteers and suppliers.`,
      href: "/org/finance?status=pending&type=expense",
    });
  }

  const refunds = get<{ n: number; total: number | null }>(
    `SELECT COUNT(*) AS n, SUM(amount_cents) AS total FROM transactions
     WHERE voided_at IS NULL AND status = 'pending' AND source = 'refund'`,
  )!;
  if (refunds.n > 0) {
    alerts.push({
      kind: "refunds_due",
      severity: "warning",
      title: `${plural(refunds.n, "refund")} due`,
      detail: `${formatMoney(refunds.total ?? 0)} must be returned for cancelled tickets or orders.`,
      href: "/org/finance?status=pending&type=expense",
    });
  }

  const unpaidTickets = get<{ n: number; total: number | null }>(
    `SELECT COUNT(*) AS n, SUM(t.price_cents) AS total FROM tickets t JOIN events e ON e.id = t.event_id
     WHERE t.status = 'valid' AND t.payment_status = 'pending' AND e.status = 'published'`,
  )!;
  if (unpaidTickets.n > 0) {
    alerts.push({
      kind: "unpaid_tickets",
      severity: "info",
      title: `${plural(unpaidTickets.n, "ticket")} not yet paid`,
      detail: `${formatMoney(unpaidTickets.total ?? 0)} to collect before or at the door.`,
      href: "/org/finance?status=pending&type=income",
    });
  }

  if (members.expiring > 0) {
    alerts.push({
      kind: "expiring_members",
      severity: "info",
      title: `${plural(members.expiring, "membership")} ending within ${SETTINGS.renewalReminderDays} days`,
      detail: "Remind these members to renew before their discounts stop.",
      href: "/org/members?status=expiring",
    });
  }

  const lowStock = all<{ name: string; size: string; stock: number }>(
    `SELECT p.name, v.size, v.stock FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE p.active = 1 AND v.stock <= ? ORDER BY v.stock ASC, p.name ASC`,
    SETTINGS.lowStockThreshold,
  );
  if (lowStock.length > 0) {
    alerts.push({
      kind: "low_stock",
      severity: "info",
      title: `${plural(lowStock.length, "size")} low or out of stock`,
      detail: lowStock
        .slice(0, 3)
        .map((v) => `${v.name} ${v.size}: ${v.stock === 0 ? "sold out" : `${v.stock} left`}`)
        .join("; "),
      href: "/org/merch",
    });
  }

  const next = upcoming[0];
  return {
    generatedAt: nowIso(),
    members: {
      total: members.total,
      active: members.active + members.expiring,
      expiring: members.expiring,
      lapsed: members.lapsed,
      unpaid: members.unpaid,
    },
    events: {
      total: events.length,
      upcoming: upcoming.length,
      past: live.filter((e) => e.status === "published" && e.phase === "past").length,
      draft: events.filter((e) => e.status === "draft").length,
      next: next
        ? {
            id: next.id,
            title: next.title,
            startsAt: next.startsAt,
            registered: next.stats.registered,
            capacity: next.capacity,
          }
        : null,
    },
    tickets: {
      registered: ticketTotals.registered,
      paid: ticketTotals.paid,
      pending: ticketTotals.pending,
      free: ticketTotals.free,
      checkedIn: ticketTotals.checkedIn,
      attendanceRate:
        ticketTotals.startedRegistered > 0
          ? ticketTotals.startedCheckedIn / ticketTotals.startedRegistered
          : null,
    },
    finance,
    tasks: {
      open: tasks.filter((t) => t.status !== "done").length,
      overdue: overdue.length,
      done: tasks.filter((t) => t.status === "done").length,
    },
    eventPerformance: events
      .filter((e) => e.status !== "draft")
      .map((e) => ({
        id: e.id,
        title: e.title,
        startsAt: e.startsAt,
        status: e.status,
        phase: e.phase,
        capacity: e.capacity,
        registered: e.stats.registered,
        checkedIn: e.stats.checkedIn,
        incomeSettledCents: e.finance.incomeSettledCents,
        expenseSettledCents: e.finance.expenseSettledCents,
        netCents: e.finance.netCents,
      })),
    cashflow: getMonthlyCashflow(),
    alerts,
  };
}
