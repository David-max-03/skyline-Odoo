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

export function registerForEvent(
  eventId: string,
  input: RegistrationInput,
  options: RegisterOptions = {},
): Ticket {
  if (options.payNow) requireRole(options.actor, "admin", "organizer", "treasurer");

  return tx(() => {
    const event = get<EventRow>("SELECT * FROM events WHERE id = ?", eventId);
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
      get("SELECT 1 FROM tickets WHERE event_id = ? AND attendee_email = ? AND status = 'valid'", eventId, email)
    ) {
      throw conflict("already_registered", "This email already has a ticket for this event.");
    }

    // The seat count and the insert below are inside one write transaction.
    const taken =
      get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE event_id = ? AND status = 'valid'", eventId)
        ?.n ?? 0;
    if (taken >= event.capacity) {
      throw conflict("sold_out", "This event is full.");
    }

    let memberId: string | null = null;
    if (input.memberNo) {
      const member = findActiveMember(email, input.memberNo);
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
    while (get("SELECT 1 FROM tickets WHERE code = ?", code)) code = newTicketCode();

    run(
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
      recordTransaction({
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
      if (options.payNow) settlePendingFor({ ticketId: id }, options.payNow);
    }

    return getTicketById(id);
  });
}

function getTicketById(id: string): Ticket {
  const row = get<TicketRow>(`${SELECT} WHERE t.id = ?`, id);
  if (!row) throw notFound("Ticket");
  return toTicket(row);
}

function findRow(rawCode: string): TicketRow | null {
  const code = normalizeTicketCode(rawCode);
  if (!code) return null;
  return get<TicketRow>(`${SELECT} WHERE t.code = ?`, code) ?? null;
}

export function listEventTickets(eventId: string): Ticket[] {
  return all<TicketRow>(`${SELECT} WHERE t.event_id = ? ORDER BY t.created_at DESC`, eventId).map(toTicket);
}

export async function getPublicTicket(rawCode: string): Promise<PublicTicket> {
  const row = findRow(rawCode);
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

export function payTicket(rawCode: string, method: PaymentMethod, actor: SessionUser | null): Ticket {
  requireRole(actor, "admin", "organizer", "treasurer");
  return tx(() => {
    const row = findRow(rawCode);
    if (!row) throw notFound("Ticket");
    if (row.status === "cancelled") throw conflict("ticket_cancelled", "This ticket was cancelled.");
    if (row.event_status === "cancelled") throw conflict("event_cancelled", "This event was cancelled.");
    if (row.payment_status !== "pending") {
      throw conflict("not_pending", "This ticket has nothing left to pay.");
    }
    if (!settlePendingFor({ ticketId: row.id }, method)) {
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

export function cancelTicket(rawCode: string, actor: SessionUser | null): TicketCancellation {
  const user = requireRole(actor, "admin", "organizer");
  return tx(() => {
    const row = findRow(rawCode);
    if (!row) throw notFound("Ticket");
    if (row.status === "cancelled") throw conflict("ticket_cancelled", "This ticket is already cancelled.");
    if (row.checked_in_at) {
      throw conflict("already_checked_in", "This ticket was already used to enter the event.");
    }
    run("UPDATE tickets SET status = 'cancelled' WHERE id = ?", row.id);
    let refundDueCents = 0;
    if (row.payment_status === "pending") {
      voidPendingFor({ ticketId: row.id }, "Ticket cancelled");
    } else if (row.payment_status === "paid" && row.event_status !== "cancelled") {
      // Money was collected, so the books must show that it is owed back.
      refundDueCents = row.price_cents;
      recordTransaction({
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
    return { ticket: getTicketById(row.id), refundDueCents };
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
export function verifyTicket(rawCode: string, eventId: string | null, actor: SessionUser | null): CheckInResult {
  requireRole(actor, "admin", "organizer", "treasurer");
  const row = findRow(rawCode);
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
export function checkIn(input: CheckInInput, actor: SessionUser | null): CheckInResult {
  const user = requireRole(actor, "admin", "organizer", "treasurer");
  return tx(() => {
    const row = findRow(input.code);
    const refused = refusal(row, input.eventId);
    if (refused) return refused;
    const ticket = row!;

    if (ticket.payment_status === "pending") {
      if (!input.collectPayment) {
        return result("payment_required", "Payment has not been collected for this ticket.", ticket);
      }
      if (!settlePendingFor({ ticketId: ticket.id }, input.method)) {
        throw new AppError("ledger_mismatch", "No pending charge was found for this ticket.", 500);
      }
    }

    // The WHERE clause is the guard: only a ticket that has never been
    // checked in can be updated, so two scans cannot both succeed.
    const updated = run(
      `UPDATE tickets SET checked_in_at = ?, checked_in_by = ?
       WHERE id = ? AND checked_in_at IS NULL AND status = 'valid'`,
      nowIso(),
      user.id,
      ticket.id,
    );
    const fresh = get<TicketRow>(`${SELECT} WHERE t.id = ?`, ticket.id)!;
    if (updated.changes !== 1) {
      return result("already_checked_in", "This ticket has already been used.", fresh);
    }
    return result("checked_in", `${fresh.attendee_name} is checked in.`, fresh);
  });
}

/** Reverses a check-in made by mistake. */
export function undoCheckIn(rawCode: string, actor: SessionUser | null): Ticket {
  requireRole(actor, "admin", "organizer");
  const row = findRow(rawCode);
  if (!row) throw notFound("Ticket");
  if (!row.checked_in_at) throw conflict("not_checked_in", "This ticket has not been checked in.");
  run("UPDATE tickets SET checked_in_at = NULL, checked_in_by = NULL WHERE id = ?", row.id);
  return getTicketById(row.id);
}
