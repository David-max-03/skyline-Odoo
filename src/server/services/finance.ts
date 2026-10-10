import type {
  EventFinance,
  FinanceSummary,
  FinanceTotals,
  MemberPayment,
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
  claim_id: string | null;
}

const SELECT = `
  SELECT t.*, e.title AS event_title, u.name AS created_by_name, c.id AS claim_id
  FROM transactions t
  LEFT JOIN events e ON e.id = t.event_id
  LEFT JOIN users u ON u.id = t.created_by
  LEFT JOIN expense_claims c ON c.transaction_id = t.id`;

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
    claimId: r.claim_id,
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

export async function recordTransaction(t: NewTransaction): Promise<string> {
  const id = newId("txn");
  const ts = nowIso();
  await run(
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
async function applySettlement(row: TxRow, method: PaymentMethod | null, note: string | null = null): Promise<void> {
  const ts = nowIso();
  const result = await run(
    `UPDATE transactions SET status = 'settled', settled_at = ?, method = COALESCE(?, method),
            description = description || COALESCE(' · ' || ?, '')
     WHERE id = ? AND status = 'pending' AND voided_at IS NULL`,
    ts,
    method,
    note,
    row.id,
  );
  if (result.changes !== 1) {
    throw conflict("not_pending", "This entry is not awaiting payment.");
  }
  if (row.source === "ticket" && row.ticket_id) {
    await run("UPDATE tickets SET payment_status = 'paid' WHERE id = ?", row.ticket_id);
  }
  if (row.source === "order" && row.order_id) {
    await run("UPDATE orders SET payment_status = 'paid' WHERE id = ?", row.order_id);
  }
  if (row.source === "dues" && row.period_id) {
    await run("UPDATE membership_periods SET paid_at = ? WHERE id = ? AND paid_at IS NULL", ts, row.period_id);
  }
  // Paying the ledger entry of an approved claim is what marks the claim paid,
  // whichever screen the payment was recorded from.
  await run("UPDATE expense_claims SET status = 'paid' WHERE transaction_id = ? AND status = 'approved'", row.id);
}

type Link = { ticketId: string } | { orderId: string } | { periodId: string };

function linkClause(link: Link): { column: string; value: string } {
  if ("ticketId" in link) return { column: "ticket_id", value: link.ticketId };
  if ("orderId" in link) return { column: "order_id", value: link.orderId };
  return { column: "period_id", value: link.periodId };
}

/**
 * Settles the pending income row for a ticket, order or membership term.
 * `note` is appended to the entry's description, e.g. a payment reference.
 */
export async function settlePendingFor(link: Link, method: PaymentMethod | null, note: string | null = null): Promise<boolean> {
  const { column, value } = linkClause(link);
  return tx(async () => {
    const row = await get<TxRow>(
      `${SELECT} WHERE t.${column} = ? AND t.type = 'income' AND t.status = 'pending' AND t.voided_at IS NULL`,
      value,
    );
    if (!row) return false;
    await applySettlement(row, method, note);
    return true;
  });
}

/** Voids pending income for a cancelled ticket, order or membership term. */
export async function voidPendingFor(link: Link, reason: string): Promise<number> {
  const { column, value } = linkClause(link);
  return (await run(
    `UPDATE transactions SET voided_at = ?, void_reason = ?
     WHERE ${column} = ? AND type = 'income' AND status = 'pending' AND voided_at IS NULL`,
    nowIso(),
    reason,
    value,
  )).changes;
}

// ---------------------------------------------------------------------------
// Staff operations
// ---------------------------------------------------------------------------

async function assertEventExists(eventId: string | null): Promise<void> {
  if (eventId && !await get("SELECT 1 FROM events WHERE id = ?", eventId)) {
    throw invalid("Choose an existing event.", { eventId: "This event no longer exists" });
  }
}

export async function getTransaction(id: string): Promise<Transaction> {
  const row = await get<TxRow>(`${SELECT} WHERE t.id = ?`, id);
  if (!row) throw notFound("Transaction");
  return toTransaction(row);
}

export async function createTransaction(input: TransactionInput, actor: SessionUser | null): Promise<Transaction> {
  // Only finance staff write to the ledger by hand. Everyone else asks to be
  // reimbursed through an expense claim, which needs a receipt photo.
  if (actor && actor.role === "organizer") {
    throw forbidden("File an expense claim with a photo of the receipt; the treasurer records it in the ledger.");
  }
  const user = requireRole(actor, "admin", "treasurer");
  await assertEventExists(input.eventId);
  const id = await recordTransaction({ ...input, source: "manual", createdBy: user.id });
  return getTransaction(id);
}

export async function updateTransaction(
  id: string,
  input: TransactionInput,
  actor: SessionUser | null,
): Promise<Transaction> {
  requireRole(actor, "admin", "treasurer");
  return tx(async () => {
    const row = await get<TxRow>(`${SELECT} WHERE t.id = ?`, id);
    if (!row) throw notFound("Transaction");
    if (row.voided_at) throw conflict("voided", "A voided entry cannot be edited.");
    if (row.source !== "manual" || row.claim_id) {
      throw conflict(
        "linked_entry",
        "This entry was created by a ticket, order, membership or expense claim and follows that record.",
      );
    }
    await assertEventExists(input.eventId);
    const settledAt =
      input.status === "settled" ? (row.settled_at ?? nowIso()) : null;
    await run(
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
export async function settleTransaction(
  id: string,
  method: PaymentMethod | null,
  actor: SessionUser | null,
): Promise<Transaction> {
  requireRole(actor, "admin", "treasurer");
  return tx(async () => {
    const row = await get<TxRow>(`${SELECT} WHERE t.id = ?`, id);
    if (!row) throw notFound("Transaction");
    if (row.voided_at) throw conflict("voided", "A voided entry cannot be settled.");
    await applySettlement(row, method);
    return getTransaction(id);
  });
}

export async function voidTransaction(id: string, reason: string, actor: SessionUser | null): Promise<Transaction> {
  requireRole(actor, "admin", "treasurer");
  return tx(async () => {
    const row = await get<TxRow>(`${SELECT} WHERE t.id = ?`, id);
    if (!row) throw notFound("Transaction");
    if (row.voided_at) throw conflict("voided", "This entry is already voided.");
    if ((row.source !== "manual" && row.source !== "refund") || row.claim_id) {
      throw conflict(
        "linked_entry",
        "This entry belongs to a ticket, order, membership or expense claim. Change that record instead.",
      );
    }
    await run("UPDATE transactions SET voided_at = ?, void_reason = ? WHERE id = ?", nowIso(), reason, id);
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

export async function listTransactions(filter: TransactionFilter = {}): Promise<Transaction[]> {
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
  return (await all<TxRow>(sql, ...params)).map(toTransaction);
}

/**
 * The ledger rows that concern one member: their dues, tickets and orders
 * (matched by member id, or by their email on the ticket or order) and
 * repayments of their claims. Read-only, and limited to fields about them.
 */
export async function listMemberPayments(memberId: string): Promise<MemberPayment[]> {
  return (await all<TxRow>(
    `${SELECT}
     WHERE t.voided_at IS NULL AND (
       t.member_id = ?
       OR t.ticket_id IN (SELECT k.id FROM tickets k JOIN members m ON m.email = k.attendee_email WHERE m.id = ?)
       OR t.order_id IN (SELECT o.id FROM orders o JOIN members m ON m.email = o.buyer_email WHERE m.id = ?)
       OR c.claimant_member_id = ?
     )
     ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT 200`,
    memberId,
    memberId,
    memberId,
    memberId,
  )).map((r) => ({
    id: r.id,
    description: r.description,
    type: r.type,
    amountCents: r.amount_cents,
    status: r.status,
    occurredOn: r.occurred_on,
    method: r.method,
  }));
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
export async function eventFinanceMap(): Promise<Map<string, EventFinance>> {
  const rows = await all<{
    event_id: string;
    type: TransactionType;
    status: TransactionStatus;
    is_ticket: number;
    total: number;
  }>(
    `SELECT event_id, type, status, CASE WHEN source = 'ticket' THEN 1 ELSE 0 END AS is_ticket,
            SUM(amount_cents) AS total
     FROM transactions
     WHERE voided_at IS NULL AND event_id IS NOT NULL
     GROUP BY event_id, type, status, CASE WHEN source = 'ticket' THEN 1 ELSE 0 END`,
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

export async function eventFinance(eventId: string): Promise<EventFinance> {
  return (await eventFinanceMap()).get(eventId) ?? emptyEventFinance();
}

export async function getFinanceTotals(): Promise<FinanceTotals> {
  const rows = await all<{ type: TransactionType; status: TransactionStatus; total: number }>(
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

export async function getMonthlyCashflow(): Promise<FinanceSummary["byMonth"]> {
  const rows = await all<{ month: string; income: number; expense: number }>(
    `SELECT substr(occurred_on, 1, 7) AS month,
            SUM(CASE WHEN type = 'income' THEN amount_cents ELSE 0 END) AS income,
            SUM(CASE WHEN type = 'expense' THEN amount_cents ELSE 0 END) AS expense
     FROM transactions
     WHERE voided_at IS NULL AND status = 'settled'
     GROUP BY substr(occurred_on, 1, 7) ORDER BY substr(occurred_on, 1, 7)`,
  );
  return rows.map((r) => ({
    month: r.month,
    incomeCents: r.income,
    expenseCents: r.expense,
    netCents: r.income - r.expense,
  }));
}

export async function getFinanceSummary(): Promise<FinanceSummary> {
  const totals = await getFinanceTotals();

  const categoryRows = await all<{
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
     GROUP BY type, category ORDER BY type DESC, SUM(amount_cents) DESC, category`,
  );

  const perEvent = await eventFinanceMap();
  const titles = await all<{ id: string; title: string }>("SELECT id, title FROM events ORDER BY starts_at DESC");
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
    transactionCount: (await get<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE voided_at IS NULL"))!.n,
    byCategory: categoryRows.map((r) => ({
      type: r.type,
      category: r.category,
      settledCents: r.settled,
      pendingCents: r.pending,
      count: r.n,
    })),
    byMonth: await getMonthlyCashflow(),
    byEvent,
  };
}
