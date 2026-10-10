import QRCode from "qrcode";
import type {
  CheckInInput,
  CheckInOutcome,
  CheckInResult,
  EventStatus,
  PaymentMethod,
  PublicTicket,
  RegistrationInput,
  SessionUser,
  Ticket,
  TicketPaymentStatus,
  TicketStatus,
} from "@/lib/contracts";
import { all, get, newId, now, nowIso, randomCode, run, tx } from "../db";
import { AppError, conflict, invalid, notFound, requireRole } from "../errors";
import type { EventRow } from "./events";
import { recordTransaction, settlePendingFor, voidPendingFor } from "./finance";
import { findActiveMember } from "./members";

/**
 * Registration, tickets and check-in.
 *
 * One registration is one ticket row. A ticket's payment status mirrors its
 * linked ledger row and both change in the same database transaction.
 */

interface TicketRow {
  id: string;
  code: string;
  event_id: string;
  attendee_name: string;
  attendee_email: string;
  student_id: string | null;
  member_id: string | null;
  price_cents: number;
  payment_status: TicketPaymentStatus;
  status: TicketStatus;
  checked_in_at: string | null;
  created_at: string;
  event_title: string;
  event_status: EventStatus;
  event_venue: string;
  event_starts_at: string;
  event_ends_at: string;
  member_no: string | null;
  checked_in_by_name: string | null;
}

const SELECT = `
  SELECT t.*, e.title AS event_title, e.status AS event_status, e.venue AS event_venue,
         e.starts_at AS event_starts_at, e.ends_at AS event_ends_at,
         m.member_no AS member_no, u.name AS checked_in_by_name
  FROM tickets t
  JOIN events e ON e.id = t.event_id
  LEFT JOIN members m ON m.id = t.member_id
  LEFT JOIN users u ON u.id = t.checked_in_by`;

function toTicket(r: TicketRow): Ticket {
  return {
    id: r.id,
    code: r.code,
    eventId: r.event_id,
    eventTitle: r.event_title,
    attendeeName: r.attendee_name,
    attendeeEmail: r.attendee_email,
    studentId: r.student_id,
    memberId: r.member_id,
    memberNo: r.member_no,
    priceCents: r.price_cents,
    paymentStatus: r.payment_status,
    status: r.status,
    checkedInAt: r.checked_in_at,
    checkedInByName: r.checked_in_by_name,
    createdAt: r.created_at,
  };
}

// --- ticket codes ------------------------------------------------------------

const CODE_BODY = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/;

export function newTicketCode(): string {
  const body = randomCode(10);
  return `SKY-${body.slice(0, 5)}-${body.slice(5)}`;
}

/**
 * Accepts what a scanner or a person might supply ("sky 7kq2m 9xwpa", a ticket
 * URL, the bare ten characters) and returns the canonical code, or null when
 * it cannot be a Skyline ticket code.
 */
export function normalizeTicketCode(input: string): string | null {
  let value = input.trim();
  const fromUrl = /\/t\/([^/?#\s]+)/i.exec(value);
  if (fromUrl) value = decodeURIComponent(fromUrl[1]);
  let body = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (body.startsWith("SKY") && body.length === 13) body = body.slice(3);
  if (!CODE_BODY.test(body)) return null;
  return `SKY-${body.slice(0, 5)}-${body.slice(5)}`;
}

// --- registration ------------------------------------------------------------

export interface RegisterOptions {
  /** Staff member registering someone at the desk. */
  actor?: SessionUser | null;
  /** Staff only: record payment at the same time. */
  payNow?: PaymentMethod | null;
}

export async function registerForEvent(
  eventId: string,
  input: RegistrationInput,
  options: RegisterOptions = {},
): Promise<Ticket> {
  if (options.payNow) requireRole(options.actor, "admin", "organizer", "treasurer");

  return tx(async () => {
    const event = await get<EventRow>("SELECT * FROM events WHERE id = ?", eventId);
    // Draft events are invisible to the public, so they look the same as missing ones.
    if (!event || (event.status === "draft" && !options.actor)) throw notFound("Event");
    if (event.status === "cancelled") {
      throw conflict("registration_closed", "This event was cancelled.");
    }
    if (event.status !== "published") {
      throw conflict("registration_closed", "Publish this event before registering people.");
    }
    if (Date.parse(event.ends_at) <= now().getTime()) {
      throw conflict("registration_closed", "This event has already ended.");
    }

    const email = input.email.toLowerCase();
    if (
      await get("SELECT 1 FROM tickets WHERE event_id = ? AND attendee_email = ? AND status = 'valid'", eventId, email)
    ) {
      throw conflict("already_registered", "This email already has a ticket for this event.");
    }

    // The seat count and the insert below are inside one write transaction.
    const taken =
      (await get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE event_id = ? AND status = 'valid'", eventId))
        ?.n ?? 0;
    if (taken >= event.capacity) {
      throw conflict("sold_out", "This event is full.");
    }

    let memberId: string | null = null;
    if (input.memberNo) {
      const member = await findActiveMember(email, input.memberNo);
      if (!member) {
        throw invalid("We could not apply the member price.", {
          memberNo:
            "This member number and email do not match an active, paid-up membership. Clear the field to pay the standard price.",
        });
      }
      memberId = member.id;
    }

    const priceCents = memberId ? event.member_price_cents : event.price_cents;
    const id = newId("tkt");
    const paymentStatus: TicketPaymentStatus = priceCents === 0 ? "free" : "pending";

    // Codes are random; retry on the (astronomically unlikely) collision.
    let code = newTicketCode();
    while (await get("SELECT 1 FROM tickets WHERE code = ?", code)) code = newTicketCode();

    await run(
      `INSERT INTO tickets
         (id, code, event_id, attendee_name, attendee_email, student_id, member_id, price_cents,
          payment_status, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?)`,
      id,
      code,
      eventId,
      input.name,
      email,
      input.studentId,
      memberId,
      priceCents,
      paymentStatus,
      nowIso(),
    );

    if (priceCents > 0) {
      await recordTransaction({
        type: "income",
        category: "tickets",
        amountCents: priceCents,
        status: "pending",
        description: `Ticket ${code} — ${event.title}`,
        counterparty: input.name,
        source: "ticket",
        eventId,
        ticketId: id,
        memberId,
        createdBy: options.actor?.id ?? null,
      });
      if (options.payNow) await settlePendingFor({ ticketId: id }, options.payNow);
    }

    return getTicketById(id);
  });
}

/**
 * A signed-in member registers themselves. The name and email come from their
 * member record, not from the request, and the member price applies only when
 * a paid term covers today. Everything else (capacity, one ticket per person,
 * the pending charge) is the same code path as any other registration, so a
 * paid event's ticket stays unpaid until staff record the payment.
 */
export async function registerMember(eventId: string, memberId: string): Promise<Ticket> {
  const member = await get<{ name: string; email: string; student_id: string | null; member_no: string }>(
    "SELECT name, email, student_id, member_no FROM members WHERE id = ?",
    memberId,
  );
  if (!member) throw notFound("Member");
  const active = await findActiveMember(member.email, member.member_no);
  return registerForEvent(eventId, {
    name: member.name,
    email: member.email,
    studentId: member.student_id,
    memberNo: active ? member.member_no : null,
  });
}

/**
 * A member gives up their own seat. Allowed only for a ticket that is theirs,
 * has not been used, and has not been paid for: a paid ticket needs a refund
 * recorded, which is the committee's job. Someone else's ticket looks missing.
 */
export async function cancelOwnTicket(rawCode: string, memberId: string): Promise<Ticket> {
  return tx(async () => {
    const member = await get<{ email: string }>("SELECT email FROM members WHERE id = ?", memberId);
    const row = await findRow(rawCode);
    if (!member || !row || (row.member_id !== memberId && row.attendee_email.toLowerCase() !== member.email.toLowerCase())) {
      throw notFound("Ticket");
    }
    if (row.status === "cancelled") throw conflict("ticket_cancelled", "This ticket is already cancelled.");
    if (row.checked_in_at) throw conflict("already_checked_in", "This ticket was already used to enter the event.");
    if (row.payment_status === "paid") {
      throw conflict("paid_ticket", "This ticket is paid. Ask the committee to cancel it so your refund is recorded.");
    }
    await run("UPDATE tickets SET status = 'cancelled' WHERE id = ? AND status = 'valid' AND checked_in_at IS NULL", row.id);
    await voidPendingFor({ ticketId: row.id }, "Cancelled by the member");
    return getTicketById(row.id);
  });
}

async function getTicketById(id: string): Promise<Ticket> {
  const row = await get<TicketRow>(`${SELECT} WHERE t.id = ?`, id);
  if (!row) throw notFound("Ticket");
  return toTicket(row);
}

async function findRow(rawCode: string): Promise<TicketRow | null> {
  const code = normalizeTicketCode(rawCode);
  if (!code) return null;
  return await get<TicketRow>(`${SELECT} WHERE t.code = ?`, code) ?? null;
}

export async function listEventTickets(eventId: string): Promise<Ticket[]> {
  return (await all<TicketRow>(`${SELECT} WHERE t.event_id = ? ORDER BY t.created_at DESC`, eventId)).map(toTicket);
}

export async function getPublicTicket(rawCode: string): Promise<PublicTicket> {
  const row = await findRow(rawCode);
  if (!row) throw notFound("Ticket");
  const qrSvg = await QRCode.toString(row.code, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0b1220", light: "#ffffff" },
  });
  return {
    code: row.code,
    attendeeName: row.attendee_name,
    isMember: row.member_id !== null,
    priceCents: row.price_cents,
    paymentStatus: row.payment_status,
    status: row.status,
    checkedInAt: row.checked_in_at,
    event: {
      id: row.event_id,
      title: row.event_title,
      venue: row.event_venue,
      startsAt: row.event_starts_at,
      endsAt: row.event_ends_at,
      status: row.event_status,
    },
    qrSvg,
  };
}

// --- payment and cancellation --------------------------------------------------

export async function payTicket(rawCode: string, method: PaymentMethod, actor: SessionUser | null): Promise<Ticket> {
  requireRole(actor, "admin", "organizer", "treasurer");
  return tx(async () => {
    const row = await findRow(rawCode);
    if (!row) throw notFound("Ticket");
    if (row.status === "cancelled") throw conflict("ticket_cancelled", "This ticket was cancelled.");
    if (row.event_status === "cancelled") throw conflict("event_cancelled", "This event was cancelled.");
    if (row.payment_status !== "pending") {
      throw conflict("not_pending", "This ticket has nothing left to pay.");
    }
    if (!await settlePendingFor({ ticketId: row.id }, method)) {
      throw new AppError("ledger_mismatch", "No pending charge was found for this ticket.", 500);
    }
    return getTicketById(row.id);
  });
}

export interface TicketCancellation {
  ticket: Ticket;
  /** Set when the ticket had been paid and a refund is now owed. */
  refundDueCents: number;
}

export async function cancelTicket(rawCode: string, actor: SessionUser | null): Promise<TicketCancellation> {
  const user = requireRole(actor, "admin", "organizer");
  return tx(async () => {
    const row = await findRow(rawCode);
    if (!row) throw notFound("Ticket");
    if (row.status === "cancelled") throw conflict("ticket_cancelled", "This ticket is already cancelled.");
    if (row.checked_in_at) {
      throw conflict("already_checked_in", "This ticket was already used to enter the event.");
    }
    await run("UPDATE tickets SET status = 'cancelled' WHERE id = ?", row.id);
    let refundDueCents = 0;
    if (row.payment_status === "pending") {
      await voidPendingFor({ ticketId: row.id }, "Ticket cancelled");
    } else if (row.payment_status === "paid" && row.event_status !== "cancelled") {
      // Money was collected, so the books must show that it is owed back.
      refundDueCents = row.price_cents;
      await recordTransaction({
        type: "expense",
        category: "refund",
        amountCents: row.price_cents,
        status: "pending",
        description: `Refund due for cancelled ticket ${row.code} — ${row.event_title}`,
        counterparty: row.attendee_name,
        source: "refund",
        eventId: row.event_id,
        ticketId: row.id,
        memberId: row.member_id,
        createdBy: user.id,
      });
    }
    return { ticket: await getTicketById(row.id), refundDueCents };
  });
}

// --- check-in ------------------------------------------------------------------

function result(outcome: CheckInOutcome, message: string, row: TicketRow | null): CheckInResult {
  return {
    outcome,
    message,
    ticket: row && {
      code: row.code,
      attendeeName: row.attendee_name,
      eventId: row.event_id,
      eventTitle: row.event_title,
      isMember: row.member_id !== null,
      memberNo: row.member_no,
      priceCents: row.price_cents,
      paymentStatus: row.payment_status,
      checkedInAt: row.checked_in_at,
      checkedInByName: row.checked_in_by_name,
    },
  };
}

/** Why a ticket cannot be admitted, or null when it can. Changes nothing. */
function refusal(row: TicketRow | null, eventId: string | null): CheckInResult | null {
  if (!row) return result("not_found", "No ticket matches this code.", null);
  if (eventId && row.event_id !== eventId) {
    return result("wrong_event", `This ticket is for a different event: ${row.event_title}.`, row);
  }
  // Checked first: cancelling an event cancels its tickets, and the door should hear why.
  if (row.event_status === "cancelled") return result("event_cancelled", "This event was cancelled.", row);
  if (row.status === "cancelled") return result("cancelled", "This ticket was cancelled.", row);
  if (row.checked_in_at) {
    return result("already_checked_in", "This ticket has already been used.", row);
  }
  return null;
}

/** Looks a ticket up for the door without changing it. */
export async function verifyTicket(rawCode: string, eventId: string | null, actor: SessionUser | null): Promise<CheckInResult> {
  requireRole(actor, "admin", "organizer", "treasurer");
  const row = await findRow(rawCode);
  const refused = refusal(row, eventId);
  if (refused) return refused;
  if (row!.payment_status === "pending") {
    return result("payment_required", "Payment has not been collected for this ticket.", row);
  }
  return result("valid", "Valid ticket. Not yet checked in.", row);
}

/**
 * Admits a ticket holder. Expected refusals come back as an outcome rather
 * than an error, because the door screen needs to show who and why.
 */
export async function checkIn(input: CheckInInput, actor: SessionUser | null): Promise<CheckInResult> {
  const user = requireRole(actor, "admin", "organizer", "treasurer");
  return tx(async () => {
    const row = await findRow(input.code);
    const refused = refusal(row, input.eventId);
    if (refused) return refused;
    const ticket = row!;

    if (ticket.payment_status === "pending") {
      if (!input.collectPayment) {
        return result("payment_required", "Payment has not been collected for this ticket.", ticket);
      }
      if (!await settlePendingFor({ ticketId: ticket.id }, input.method)) {
        throw new AppError("ledger_mismatch", "No pending charge was found for this ticket.", 500);
      }
    }

    // The WHERE clause is the guard: only a ticket that has never been
    // checked in can be updated, so two scans cannot both succeed.
    const updated = await run(
      `UPDATE tickets SET checked_in_at = ?, checked_in_by = ?
       WHERE id = ? AND checked_in_at IS NULL AND status = 'valid'`,
      nowIso(),
      user.id,
      ticket.id,
    );
    const fresh = (await get<TicketRow>(`${SELECT} WHERE t.id = ?`, ticket.id))!;
    if (updated.changes !== 1) {
      return result("already_checked_in", "This ticket has already been used.", fresh);
    }
    return result("checked_in", `${fresh.attendee_name} is checked in.`, fresh);
  });
}

/** Reverses a check-in made by mistake. */
export async function undoCheckIn(rawCode: string, actor: SessionUser | null): Promise<Ticket> {
  requireRole(actor, "admin", "organizer");
  // Read and clear together, and only clear the check-in that was read: a
  // second undo arriving at the same moment must not wipe a newer check-in.
  return tx(async () => {
    const row = await findRow(rawCode);
    if (!row) throw notFound("Ticket");
    if (!row.checked_in_at) throw conflict("not_checked_in", "This ticket has not been checked in.");
    const cleared = await run(
      "UPDATE tickets SET checked_in_at = NULL, checked_in_by = NULL WHERE id = ? AND checked_in_at = ?",
      row.id,
      row.checked_in_at,
    );
    if (cleared.changes !== 1) throw conflict("not_checked_in", "This ticket has not been checked in.");
    return getTicketById(row.id);
  });
}
