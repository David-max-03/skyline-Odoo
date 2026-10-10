import type {
  EventFinance,
  FinanceSummary,
  FinanceTotals,
  PaymentMethod,
  SessionUser,
  Transaction,
  TransactionCategory,
  TransactionInput,
  TransactionSource,
  TransactionStatus,
  TransactionType,
} from "@/lib/contracts";
import { all, get, newId, nowIso, run, today, tx } from "../db";
import { conflict, forbidden, invalid, notFound, requireRole } from "../errors";

/**
 * The ledger. Every amount of money the club is owed, has received, owes or
 * has paid is one row in `transactions`. All financial figures anywhere in the
 * app are sums over these rows, excluding voided ones.
 *
 * status = 'settled' means money actually moved; 'pending' means it is owed.
 */

interface TxRow {
  id: string;
  type: TransactionType;
  category: TransactionCategory;
  amount_cents: number;
  status: TransactionStatus;
  occurred_on: string;
  description: string;
  counterparty: string | null;
  method: PaymentMethod | null;
  source: TransactionSource;
  event_id: string | null;
  ticket_id: string | null;
  member_id: string | null;
  period_id: string | null;
  order_id: string | null;
  created_at: string;
  settled_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  event_title: string | null;
  created_by_name: string | null;
}

const SELECT = `
  SELECT t.*, e.title AS event_title, u.name AS created_by_name
  FROM transactions t
  LEFT JOIN events e ON e.id = t.event_id
  LEFT JOIN users u ON u.id = t.created_by`;

function toTransaction(r: TxRow): Transaction {
  return {
    id: r.id,
    type: r.type,
    category: r.category,
    amountCents: r.amount_cents,
    status: r.status,
    occurredOn: r.occurred_on,
    description: r.description,
    counterparty: r.counterparty,
    method: r.method,
    source: r.source,
    eventId: r.event_id,
    eventTitle: r.event_title,
    ticketId: r.ticket_id,
    memberId: r.member_id,
    orderId: r.order_id,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    settledAt: r.settled_at,
    voidedAt: r.voided_at,
    voidReason: r.void_reason,
  };
}

// ---------------------------------------------------------------------------
// Internal writes, used by the ticket, membership and merchandise services.
// They carry no role check: the calling service has already authorised.
// ---------------------------------------------------------------------------

export interface NewTransaction {
  type: TransactionType;
  category: TransactionCategory;
  amountCents: number;
  status: TransactionStatus;
  description: string;
  occurredOn?: string;
  counterparty?: string | null;
  method?: PaymentMethod | null;
  source?: TransactionSource;
  eventId?: string | null;
  ticketId?: string | null;
  memberId?: string | null;
  periodId?: string | null;
  orderId?: string | null;
  createdBy?: string | null;
}

export function recordTransaction(t: NewTransaction): string {
  const id = newId("txn");
  const ts = nowIso();
  run(
    `INSERT INTO transactions
       (id, type, category, amount_cents, status, occurred_on, description, counterparty, method,
        source, event_id, ticket_id, member_id, period_id, order_id, created_by, created_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    t.type,
    t.category,
    t.amountCents,
    t.status,
    t.occurredOn ?? today(),
    t.description,
    t.counterparty ?? null,
    t.method ?? null,
    t.source ?? "manual",
    t.eventId ?? null,
    t.ticketId ?? null,
    t.memberId ?? null,
    t.periodId ?? null,
    t.orderId ?? null,
    t.createdBy ?? null,
    ts,
    t.status === "settled" ? ts : null,
  );
  return id;
}

/**
 * Marks one pending row as settled and updates whatever it pays for, so a
 * ticket, order or membership term can never disagree with the ledger.
 */
function applySettlement(row: TxRow, method: PaymentMethod | null): void {
  const ts = nowIso();
  const result = run(
    `UPDATE transactions SET status = 'settled', settled_at = ?, method = COALESCE(?, method)
     WHERE id = ? AND status = 'pending' AND voided_at IS NULL`,
    ts,
    method,
    row.id,
  );
  if (result.changes !== 1) {
    throw conflict("not_pending", "This entry is not awaiting payment.");
  }
  if (row.source === "ticket" && row.ticket_id) {
    run("UPDATE tickets SET payment_status = 'paid' WHERE id = ?", row.ticket_id);
  }
  if (row.source === "order" && row.order_id) {
    run("UPDATE orders SET payment_status = 'paid' WHERE id = ?", row.order_id);
  }
  if (row.source === "dues" && row.period_id) {
    run("UPDATE membership_periods SET paid_at = ? WHERE id = ? AND paid_at IS NULL", ts, row.period_id);
  }
}

type Link = { ticketId: string } | { orderId: string } | { periodId: string };

function linkClause(link: Link): { column: string; value: string } {
  if ("ticketId" in link) return { column: "ticket_id", value: link.ticketId };
  if ("orderId" in link) return { column: "order_id", value: link.orderId };
  return { column: "period_id", value: link.periodId };
}

/** Settles the pending income row for a ticket, order or membership term. */
export function settlePendingFor(link: Link, method: PaymentMethod | null): boolean {
  const { column, value } = linkClause(link);
  return tx(() => {
    const row = get<TxRow>(
      `${SELECT} WHERE t.${column} = ? AND t.type = 'income' AND t.status = 'pending' AND t.voided_at IS NULL`,
      value,
    );
    if (!row) return false;
    applySettlement(row, method);
    return true;
  });
}

/** Voids pending income for a cancelled ticket, order or membership term. */
export function voidPendingFor(link: Link, reason: string): number {
  const { column, value } = linkClause(link);
  return run(
    `UPDATE transactions SET voided_at = ?, void_reason = ?
     WHERE ${column} = ? AND type = 'income' AND status = 'pending' AND voided_at IS NULL`,
    nowIso(),
    reason,
    value,
  ).changes;
}

// ---------------------------------------------------------------------------
// Staff operations
// ---------------------------------------------------------------------------

function assertEventExists(eventId: string | null): void {
  if (eventId && !get("SELECT 1 FROM events WHERE id = ?", eventId)) {
    throw invalid("Choose an existing event.", { eventId: "This event no longer exists" });
  }
}

export function getTransaction(id: string): Transaction {
  const row = get<TxRow>(`${SELECT} WHERE t.id = ?`, id);
  if (!row) throw notFound("Transaction");
  return toTransaction(row);
}

export function createTransaction(input: TransactionInput, actor: SessionUser | null): Transaction {
  const user = requireRole(actor, "admin", "treasurer", "organizer");
  // Organizers can ask to be reimbursed; they cannot move or receive money.
  if (user.role === "organizer" && (input.type !== "expense" || input.status !== "pending")) {
    throw forbidden("Organizers can only file expense claims for the treasurer to approve.");
  }
  assertEventExists(input.eventId);
  const id = recordTransaction({ ...input, source: "manual", createdBy: user.id });
  return getTransaction(id);
}

export function updateTransaction(
  id: string,
  input: TransactionInput,
  actor: SessionUser | null,
): Transaction {
  requireRole(actor, "admin", "treasurer");
  return tx(() => {
    const row = get<TxRow>(`${SELECT} WHERE t.id = ?`, id);
    if (!row) throw notFound("Transaction");
    if (row.voided_at) throw conflict("voided", "A voided entry cannot be edited.");
    if (row.source !== "manual") {
      throw conflict(
        "linked_entry",
        "This entry was created by a ticket, order or membership and follows that record.",
      );
    }
    assertEventExists(input.eventId);
    const settledAt =
      input.status === "settled" ? (row.settled_at ?? nowIso()) : null;
    run(
      `UPDATE transactions SET type = ?, category = ?, amount_cents = ?, status = ?, occurred_on = ?,
         description = ?, counterparty = ?, method = ?, event_id = ?, settled_at = ?
       WHERE id = ?`,
      input.type,
      input.category,
      input.amountCents,
      input.status,
      input.occurredOn,
      input.description,
      input.counterparty,
      input.method,
      input.eventId,
      settledAt,
      id,
    );
    return getTransaction(id);
  });
}

/** Treasurer confirms that a pending amount was collected or paid out. */
export function settleTransaction(
  id: string,
  method: PaymentMethod | null,
  actor: SessionUser | null,
): Transaction {
  requireRole(actor, "admin", "treasurer");
  return tx(() => {
    const row = get<TxRow>(`${SELECT} WHERE t.id = ?`, id);
    if (!row) throw notFound("Transaction");
    if (row.voided_at) throw conflict("voided", "A voided entry cannot be settled.");
    applySettlement(row, method);
    return getTransaction(id);
  });
}

export function voidTransaction(id: string, reason: string, actor: SessionUser | null): Transaction {
  requireRole(actor, "admin", "treasurer");
  return tx(() => {
    const row = get<TxRow>(`${SELECT} WHERE t.id = ?`, id);
    if (!row) throw notFound("Transaction");
    if (row.voided_at) throw conflict("voided", "This entry is already voided.");
    if (row.source !== "manual" && row.source !== "refund") {
      throw conflict(
        "linked_entry",
        "This entry belongs to a ticket, order or membership. Cancel that record instead.",
      );
    }
    run("UPDATE transactions SET voided_at = ?, void_reason = ? WHERE id = ?", nowIso(), reason, id);
    return getTransaction(id);
  });
}

export interface TransactionFilter {
  type?: string | null;
  status?: string | null;
  category?: string | null;
  eventId?: string | null;
  includeVoided?: boolean;
}

export function listTransactions(filter: TransactionFilter = {}): Transaction[] {
  const where: string[] = [];
  const params: (string | null)[] = [];
  if (!filter.includeVoided) where.push("t.voided_at IS NULL");
  const equals = (column: string, value: string | null | undefined) => {
    if (!value) return;
    where.push(`t.${column} = ?`);
    params.push(value);
  };
  equals("type", filter.type);
  equals("status", filter.status);
  equals("category", filter.category);
  if (filter.eventId === "none") where.push("t.event_id IS NULL");
  else equals("event_id", filter.eventId);
  const sql = `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT 1000`;
  return all<TxRow>(sql, ...params).map(toTransaction);
}

// ---------------------------------------------------------------------------
// Reporting. Every figure is a SUM over non-voided ledger rows.
// ---------------------------------------------------------------------------

export function emptyEventFinance(): EventFinance {
  return {
    incomeSettledCents: 0,
    incomePendingCents: 0,
    expenseSettledCents: 0,
    expensePendingCents: 0,
    ticketIncomeSettledCents: 0,
    ticketIncomePendingCents: 0,
    netCents: 0,
    projectedNetCents: 0,
  };
}

function finish<T extends FinanceTotals>(f: T): T {
  f.netCents = f.incomeSettledCents - f.expenseSettledCents;
  f.projectedNetCents =
    f.incomeSettledCents + f.incomePendingCents - f.expenseSettledCents - f.expensePendingCents;
  return f;
}

/** Financial result per event, keyed by event id. */
export function eventFinanceMap(): Map<string, EventFinance> {
  const rows = all<{
    event_id: string;
    type: TransactionType;
    status: TransactionStatus;
    is_ticket: number;
    total: number;
  }>(
    `SELECT event_id, type, status, (source = 'ticket') AS is_ticket, SUM(amount_cents) AS total
     FROM transactions
     WHERE voided_at IS NULL AND event_id IS NOT NULL
     GROUP BY event_id, type, status, is_ticket`,
  );
  const map = new Map<string, EventFinance>();
  for (const r of rows) {
    const f = map.get(r.event_id) ?? emptyEventFinance();
    if (r.type === "income") {
      if (r.status === "settled") f.incomeSettledCents += r.total;
      else f.incomePendingCents += r.total;
      if (r.is_ticket) {
        if (r.status === "settled") f.ticketIncomeSettledCents += r.total;
        else f.ticketIncomePendingCents += r.total;
      }
    } else if (r.status === "settled") f.expenseSettledCents += r.total;
    else f.expensePendingCents += r.total;
    map.set(r.event_id, f);
  }
  for (const f of map.values()) finish(f);
  return map;
}

export function eventFinance(eventId: string): EventFinance {
  return eventFinanceMap().get(eventId) ?? emptyEventFinance();
}

export function getFinanceTotals(): FinanceTotals {
  const rows = all<{ type: TransactionType; status: TransactionStatus; total: number }>(
    `SELECT type, status, SUM(amount_cents) AS total FROM transactions
     WHERE voided_at IS NULL GROUP BY type, status`,
  );
  const totals: FinanceTotals = {
    incomeSettledCents: 0,
    incomePendingCents: 0,
    expenseSettledCents: 0,
    expensePendingCents: 0,
    netCents: 0,
    projectedNetCents: 0,
  };
  for (const r of rows) {
    if (r.type === "income" && r.status === "settled") totals.incomeSettledCents = r.total;
    if (r.type === "income" && r.status === "pending") totals.incomePendingCents = r.total;
    if (r.type === "expense" && r.status === "settled") totals.expenseSettledCents = r.total;
    if (r.type === "expense" && r.status === "pending") totals.expensePendingCents = r.total;
  }
  return finish(totals);
}

export function getMonthlyCashflow(): FinanceSummary["byMonth"] {
  const rows = all<{ month: string; income: number; expense: number }>(
    `SELECT substr(occurred_on, 1, 7) AS month,
            SUM(CASE WHEN type = 'income' THEN amount_cents ELSE 0 END) AS income,
            SUM(CASE WHEN type = 'expense' THEN amount_cents ELSE 0 END) AS expense
     FROM transactions
     WHERE voided_at IS NULL AND status = 'settled'
     GROUP BY month ORDER BY month`,
  );
  return rows.map((r) => ({
    month: r.month,
    incomeCents: r.income,
    expenseCents: r.expense,
    netCents: r.income - r.expense,
  }));
}

export function getFinanceSummary(): FinanceSummary {
  const totals = getFinanceTotals();

  const categoryRows = all<{
    type: TransactionType;
    category: TransactionCategory;
    settled: number;
    pending: number;
    n: number;
  }>(
    `SELECT type, category,
            SUM(CASE WHEN status = 'settled' THEN amount_cents ELSE 0 END) AS settled,
            SUM(CASE WHEN status = 'pending' THEN amount_cents ELSE 0 END) AS pending,
            COUNT(*) AS n
     FROM transactions WHERE voided_at IS NULL
     GROUP BY type, category ORDER BY type DESC, settled + pending DESC`,
  );

  const perEvent = eventFinanceMap();
  const titles = all<{ id: string; title: string }>("SELECT id, title FROM events ORDER BY starts_at DESC");
  const byEvent: FinanceSummary["byEvent"] = titles
    .filter((e) => perEvent.has(e.id))
    .map((e) => ({ eventId: e.id, title: e.title, ...perEvent.get(e.id)! }));

  // Whatever is not linked to an event: dues, merchandise, general costs.
  const general = emptyEventFinance();
  for (const key of [
    "incomeSettledCents",
    "incomePendingCents",
    "expenseSettledCents",
    "expensePendingCents",
  ] as const) {
    general[key] = totals[key] - byEvent.reduce((sum, e) => sum + e[key], 0);
  }
  byEvent.push({ eventId: null, title: "General (not tied to an event)", ...finish(general) });

  return {
    ...totals,
    transactionCount: get<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE voided_at IS NULL")!.n,
    byCategory: categoryRows.map((r) => ({
      type: r.type,
      category: r.category,
      settledCents: r.settled,
      pendingCents: r.pending,
      count: r.n,
    })),
    byMonth: getMonthlyCashflow(),
    byEvent,
  };
}
