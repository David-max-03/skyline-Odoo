import type {
  EventFinance,
  EventInput,
  EventPhase,
  EventStats,
  EventStatus,
  EventStatusChange,
  EventSummary,
  PublicEvent,
  SessionUser,
} from "@/lib/contracts";
import { all, get, newId, now, nowIso, run, tx } from "../db";
import { conflict, invalid, notFound, requireRole } from "../errors";
import { emptyEventFinance, eventFinanceMap, recordTransaction } from "./finance";

export interface EventRow {
  id: string;
  title: string;
  description: string;
  venue: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  price_cents: number;
  member_price_cents: number;
  profit_target_cents: number | null;
  status: EventStatus;
  created_at: string;
  updated_at: string;
}

interface TicketCounts {
  registered: number;
  paid: number;
  pending: number;
  free: number;
  checked_in: number;
}

const NO_TICKETS: TicketCounts = { registered: 0, paid: 0, pending: 0, free: 0, checked_in: 0 };

export function phaseOf(row: Pick<EventRow, "starts_at" | "ends_at">, at: Date = now()): EventPhase {
  const t = at.getTime();
  if (t < Date.parse(row.starts_at)) return "upcoming";
  if (t < Date.parse(row.ends_at)) return "live";
  return "past";
}

async function ticketCounts(): Promise<Map<string, TicketCounts>> {
  const rows = await all<TicketCounts & { event_id: string }>(
    `SELECT event_id,
            COUNT(*) AS registered,
            SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid,
            SUM(CASE WHEN payment_status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN payment_status = 'free' THEN 1 ELSE 0 END) AS free,
            SUM(CASE WHEN checked_in_at IS NOT NULL THEN 1 ELSE 0 END) AS checked_in
     FROM tickets WHERE status = 'valid' GROUP BY event_id`,
  );
  return new Map(rows.map((r) => [r.event_id, r]));
}

function toStats(row: EventRow, c: TicketCounts, phase: EventPhase): EventStats {
  return {
    registered: c.registered,
    remaining: Math.max(0, row.capacity - c.registered),
    paid: c.paid,
    pending: c.pending,
    free: c.free,
    checkedIn: c.checked_in,
    attendanceRate: phase === "upcoming" || c.registered === 0 ? null : c.checked_in / c.registered,
  };
}

function toSummary(row: EventRow, counts: TicketCounts, finance: EventFinance): EventSummary {
  const phase = phaseOf(row);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    venue: row.venue,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    capacity: row.capacity,
    priceCents: row.price_cents,
    memberPriceCents: row.member_price_cents,
    profitTargetCents: row.profit_target_cents,
    status: row.status,
    phase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats: toStats(row, counts, phase),
    finance,
  };
}

export async function listEvents(): Promise<EventSummary[]> {
  const counts = await ticketCounts();
  const finance = await eventFinanceMap();
  return (await all<EventRow>("SELECT * FROM events ORDER BY starts_at DESC")).map((row) =>
    toSummary(row, counts.get(row.id) ?? NO_TICKETS, finance.get(row.id) ?? emptyEventFinance()),
  );
}

export async function getEvent(id: string): Promise<EventSummary> {
  const row = await get<EventRow>("SELECT * FROM events WHERE id = ?", id);
  if (!row) throw notFound("Event");
  return toSummary(
    row,
    (await ticketCounts()).get(id) ?? NO_TICKETS,
    (await eventFinanceMap()).get(id) ?? emptyEventFinance(),
  );
}

export async function createEvent(input: EventInput, actor: SessionUser | null): Promise<EventSummary> {
  const user = requireRole(actor, "admin", "organizer");
  const id = newId("evt");
  const ts = nowIso();
  await run(
    `INSERT INTO events
       (id, title, description, venue, starts_at, ends_at, capacity, price_cents, member_price_cents,
        profit_target_cents, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    id,
    input.title,
    input.description,
    input.venue,
    input.startsAt,
    input.endsAt,
    input.capacity,
    input.priceCents,
    input.memberPriceCents,
    input.profitTargetCents,
    user.id,
    ts,
    ts,
  );
  return getEvent(id);
}

export async function updateEvent(id: string, input: EventInput, actor: SessionUser | null): Promise<EventSummary> {
  requireRole(actor, "admin", "organizer");
  return tx(async () => {
    const row = await get<EventRow>("SELECT * FROM events WHERE id = ?", id);
    if (!row) throw notFound("Event");
    if (row.status === "cancelled") {
      throw conflict("event_cancelled", "A cancelled event cannot be edited.");
    }
    const registered =
      (await get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE event_id = ? AND status = 'valid'", id))
        ?.n ?? 0;
    // Never let an edit put the event over capacity after the fact.
    if (input.capacity < registered) {
      throw invalid("Capacity is below the number of people already registered.", {
        capacity: `${registered} people are already registered`,
      });
    }
    await run(
      `UPDATE events SET title = ?, description = ?, venue = ?, starts_at = ?, ends_at = ?, capacity = ?,
         price_cents = ?, member_price_cents = ?, profit_target_cents = ?, updated_at = ?
       WHERE id = ?`,
      input.title,
      input.description,
      input.venue,
      input.startsAt,
      input.endsAt,
      input.capacity,
      input.priceCents,
      input.memberPriceCents,
      input.profitTargetCents,
      nowIso(),
      id,
    );
    return getEvent(id);
  });
}

/**
 * draft → published → cancelled. A published event can go back to draft only
 * while nobody has registered. Cancelling is final: unpaid ticket charges are
 * voided and a pending refund is recorded for every ticket already paid, so
 * the treasurer can see exactly who is owed money.
 */
export async function setEventStatus(
  id: string,
  status: EventStatus,
  actor: SessionUser | null,
): Promise<EventStatusChange> {
  const user = requireRole(actor, "admin", "organizer");
  return tx(async () => {
    const row = await get<EventRow>("SELECT * FROM events WHERE id = ?", id);
    if (!row) throw notFound("Event");
    let voidedPendingCount = 0;
    let refundsDueCents = 0;

    if (row.status === status) {
      return { event: await getEvent(id), voidedPendingCount, refundsDueCents };
    }
    if (row.status === "cancelled") {
      throw conflict("event_cancelled", "A cancelled event cannot be reopened. Create a new event.");
    }
    if (status === "draft") {
      const registered =
        (await get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE event_id = ? AND status = 'valid'", id))
          ?.n ?? 0;
      if (registered > 0) {
        throw conflict(
          "has_registrations",
          "People have already registered. Cancel the event instead of unpublishing it.",
        );
      }
    }
    if (status === "cancelled") {
      const reason = "Event cancelled";
      voidedPendingCount = (await run(
        `UPDATE transactions SET voided_at = ?, void_reason = ?
         WHERE event_id = ? AND source = 'ticket' AND status = 'pending' AND voided_at IS NULL`,
        nowIso(),
        reason,
        id,
      )).changes;
      const paid = await all<{ id: string; code: string; attendee_name: string; price_cents: number; member_id: string | null }>(
        `SELECT id, code, attendee_name, price_cents, member_id FROM tickets
         WHERE event_id = ? AND status = 'valid' AND payment_status = 'paid' AND price_cents > 0`,
        id,
      );
      for (const t of paid) {
        await recordTransaction({
          type: "expense",
          category: "refund",
          amountCents: t.price_cents,
          status: "pending",
          description: `Refund due for ticket ${t.code} — ${row.title} (cancelled)`,
          counterparty: t.attendee_name,
          source: "refund",
          eventId: id,
          ticketId: t.id,
          memberId: t.member_id,
          createdBy: user.id,
        });
        refundsDueCents += t.price_cents;
      }
      // The tickets themselves are dead too. Marking them cancelled keeps every
      // ticket in step with its ledger row: no valid ticket is left pointing at
      // a voided charge.
      await run("UPDATE tickets SET status = 'cancelled' WHERE event_id = ? AND status = 'valid'", id);
    }
    await run("UPDATE events SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), id);
    return { event: await getEvent(id), voidedPendingCount, refundsDueCents };
  });
}

// ---------------------------------------------------------------------------
// Public view: published events only, and only what a visitor needs.
// ---------------------------------------------------------------------------

function toPublic(row: EventRow, registered: number): PublicEvent {
  const phase = phaseOf(row);
  const remaining = Math.max(0, row.capacity - registered);
  const closedReason = phase === "past" ? "ended" : remaining === 0 ? "sold_out" : null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    venue: row.venue,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    capacity: row.capacity,
    remaining,
    priceCents: row.price_cents,
    memberPriceCents: row.member_price_cents,
    phase,
    registrationOpen: closedReason === null,
    closedReason,
  };
}

export async function listPublicEvents(): Promise<PublicEvent[]> {
  const counts = await ticketCounts();
  return (await all<EventRow>(
    "SELECT * FROM events WHERE status = 'published' AND ends_at > ? ORDER BY starts_at ASC",
    nowIso(),
  )).map((row) => toPublic(row, counts.get(row.id)?.registered ?? 0));
}

export async function getPublicEvent(id: string): Promise<PublicEvent> {
  const row = await get<EventRow>("SELECT * FROM events WHERE id = ? AND status = 'published'", id);
  if (!row) throw notFound("Event");
  return toPublic(row, (await ticketCounts()).get(id)?.registered ?? 0);
}
