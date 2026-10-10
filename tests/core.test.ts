import { beforeEach, describe, expect, it } from "vitest";
import { eventInputSchema, transactionInputSchema, type TransactionInput } from "@/lib/contracts";
import { parseMoney, formatMoney } from "@/lib/money";
import { getSessionUser, login, logout } from "@/server/auth";
import { get, setClock, today } from "@/server/db";
import { createEvent, getEvent, getPublicEvent, listPublicEvents, setEventStatus, updateEvent } from "@/server/services/events";
import {
  createTransaction,
  getFinanceSummary,
  listTransactions,
  settleTransaction,
  voidTransaction,
} from "@/server/services/finance";
import {
  cancelTicket,
  checkIn,
  getPublicTicket,
  normalizeTicketCode,
  payTicket,
  registerForEvent,
  verifyTicket,
} from "@/server/services/tickets";
import { appError, eventInput, freshDb, person, publishedEvent, type Staff } from "./helpers";

let staff: Staff;
beforeEach(() => {
  staff = freshDb();
});

const tx = (overrides: Partial<TransactionInput>): TransactionInput =>
  transactionInputSchema.parse({
    type: "expense",
    category: "venue",
    amountCents: 100000,
    status: "settled",
    occurredOn: today(),
    description: "Test entry",
    ...overrides,
  });

const scan = (code: string, extra: Record<string, unknown> = {}) =>
  checkIn({ code, eventId: null, collectPayment: false, method: "cash", ...extra }, staff.organizer);

describe("money helpers", () => {
  it("parses typed amounts into minor units without float error", () => {
    expect(parseMoney("1,250.50")).toBe(125050);
    expect(parseMoney("0.1")).toBe(10);
    expect(parseMoney("19.99")).toBe(1999);
    expect(parseMoney("₹ 500")).toBe(50000);
    expect(parseMoney("-5")).toBeNull();
    expect(parseMoney("12.345")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
  });
  it("formats whole and fractional amounts", () => {
    expect(formatMoney(50000)).toBe("₹500");
    expect(formatMoney(125050)).toBe("₹1,250.50");
    expect(formatMoney(-2500)).toBe("−₹25");
  });
});

describe("authentication", () => {
  it("issues a session for the right password and rejects the wrong one", () => {
    expect(appError(() => login("admin@test.example", "nope")).code).toBe("invalid_credentials");
    expect(appError(() => login("nobody@test.example", "password-1")).code).toBe("invalid_credentials");
    const session = login("ADMIN@test.example", "password-1");
    expect(getSessionUser(session.token)?.role).toBe("admin");
    expect(getSessionUser("forged-token")).toBeNull();
    logout(session.token);
    expect(getSessionUser(session.token)).toBeNull();
  });
  it("expires sessions", () => {
    const session = login("admin@test.example", "password-1");
    setClock(() => new Date(Date.now() + 8 * 86_400_000));
    expect(getSessionUser(session.token)).toBeNull();
  });
});

describe("events", () => {
  it("rejects invalid event input", () => {
    const base = { title: "Gala", venue: "Hall", startsAt: "2030-01-01T10:00:00Z", endsAt: "2030-01-01T12:00:00Z", capacity: 10, priceCents: 500, memberPriceCents: 400 };
    expect(eventInputSchema.safeParse(base).success).toBe(true);
    expect(eventInputSchema.safeParse({ ...base, endsAt: "2030-01-01T09:00:00Z" }).success).toBe(false);
    expect(eventInputSchema.safeParse({ ...base, memberPriceCents: 600 }).success).toBe(false);
    expect(eventInputSchema.safeParse({ ...base, capacity: 0 }).success).toBe(false);
    expect(eventInputSchema.safeParse({ ...base, priceCents: -1 }).success).toBe(false);
    expect(eventInputSchema.safeParse({ ...base, priceCents: 10.5 }).success).toBe(false);
    expect(eventInputSchema.safeParse({ ...base, title: "" }).success).toBe(false);
  });

  it("only lets permitted roles manage events", () => {
    expect(appError(() => createEvent(eventInput(), null)).status).toBe(401);
    expect(appError(() => createEvent(eventInput(), staff.treasurer)).status).toBe(403);
    const event = createEvent(eventInput(), staff.organizer);
    expect(event.status).toBe("draft");
    expect(appError(() => setEventStatus(event.id, "published", staff.treasurer)).status).toBe(403);
  });

  it("hides drafts from the public and shows published events", () => {
    const draft = createEvent(eventInput(), staff.organizer);
    expect(listPublicEvents()).toHaveLength(0);
    expect(appError(() => getPublicEvent(draft.id)).status).toBe(404);
    expect(appError(() => registerForEvent(draft.id, person(1))).status).toBe(404);
    setEventStatus(draft.id, "published", staff.organizer);
    expect(listPublicEvents()).toHaveLength(1);
    expect(getPublicEvent(draft.id).registrationOpen).toBe(true);
  });

  it("refuses to cut capacity below the number already registered", () => {
    const event = publishedEvent(staff, { capacity: 5 });
    registerForEvent(event.id, person(1));
    registerForEvent(event.id, person(2));
    const err = appError(() => updateEvent(event.id, eventInput({ capacity: 1 }), staff.organizer));
    expect(err.status).toBe(422);
    expect(err.fields?.capacity).toBeTruthy();
    expect(updateEvent(event.id, eventInput({ capacity: 2 }), staff.organizer).stats.remaining).toBe(0);
  });

  it("will not unpublish an event that has registrations", () => {
    const event = publishedEvent(staff);
    registerForEvent(event.id, person(1));
    expect(appError(() => setEventStatus(event.id, "draft", staff.organizer)).code).toBe("has_registrations");
  });
});

describe("registration and capacity", () => {
  it("creates a unique ticket with a pending charge", async () => {
    const event = publishedEvent(staff);
    const a = registerForEvent(event.id, person(1));
    const b = registerForEvent(event.id, person(2));
    expect(a.code).toMatch(/^SKY-[2-9A-Z]{5}-[2-9A-Z]{5}$/);
    expect(a.code).not.toBe(b.code);
    expect(a.paymentStatus).toBe("pending");
    expect(a.priceCents).toBe(50000);

    const pub = await getPublicTicket(a.code);
    expect(pub.qrSvg).toContain("<svg");
    expect(pub.event.title).toBe("Test Event");
    expect(JSON.stringify(pub)).not.toContain("student1@campus.example"); // no email on the public ticket

    const pending = listTransactions({ eventId: event.id });
    expect(pending).toHaveLength(2);
    expect(pending.every((t) => t.status === "pending" && t.source === "ticket")).toBe(true);
  });

  it("enforces capacity and frees a seat when a ticket is cancelled", () => {
    const event = publishedEvent(staff, { capacity: 2 });
    const first = registerForEvent(event.id, person(1));
    registerForEvent(event.id, person(2));
    expect(appError(() => registerForEvent(event.id, person(3))).code).toBe("sold_out");
    expect(getEvent(event.id).stats.remaining).toBe(0);
    expect(getPublicEvent(event.id).closedReason).toBe("sold_out");

    cancelTicket(first.code, staff.organizer);
    expect(getEvent(event.id).stats.registered).toBe(1);
    expect(registerForEvent(event.id, person(3)).status).toBe("valid");
    expect(appError(() => registerForEvent(event.id, person(4))).code).toBe("sold_out");
  });

  it("allows one ticket per email per event, ignoring case", () => {
    const event = publishedEvent(staff);
    registerForEvent(event.id, person(1));
    const err = appError(() => registerForEvent(event.id, { ...person(1), email: "STUDENT1@campus.example" }));
    expect(err.code).toBe("already_registered");
    const other = publishedEvent(staff, { title: "Second Event" });
    expect(registerForEvent(other.id, person(1)).eventId).toBe(other.id);
  });

  it("closes registration once the event has ended or been cancelled", () => {
    const event = publishedEvent(staff);
    setClock(() => new Date(Date.now() + 3 * 86_400_000));
    expect(appError(() => registerForEvent(event.id, person(1))).code).toBe("registration_closed");
    expect(listPublicEvents()).toHaveLength(0);
    setClock(null);
    setEventStatus(event.id, "cancelled", staff.organizer);
    expect(appError(() => registerForEvent(event.id, person(1))).code).toBe("registration_closed");
  });

  it("gives free events a free ticket and no ledger entry", () => {
    const event = publishedEvent(staff, { priceCents: 0, memberPriceCents: 0 });
    const ticket = registerForEvent(event.id, person(1));
    expect(ticket.paymentStatus).toBe("free");
    expect(listTransactions()).toHaveLength(0);
    expect(scan(ticket.code).outcome).toBe("checked_in");
  });
});

describe("ticket codes", () => {
  it("normalises what scanners and people type", () => {
    expect(normalizeTicketCode("sky-7kq2m-9xwpa")).toBe("SKY-7KQ2M-9XWPA");
    expect(normalizeTicketCode("  7kq2m 9xwpa ")).toBe("SKY-7KQ2M-9XWPA");
    expect(normalizeTicketCode("https://club.example/t/SKY-7KQ2M-9XWPA?x=1")).toBe("SKY-7KQ2M-9XWPA");
    expect(normalizeTicketCode("SKY-0000O-11111")).toBeNull(); // 0, O and 1 are never issued
    expect(normalizeTicketCode("hello")).toBeNull();
    expect(normalizeTicketCode("")).toBeNull();
  });
});

describe("check-in", () => {
  it("requires payment, then admits once and only once", () => {
    const event = publishedEvent(staff);
    const ticket = registerForEvent(event.id, person(1));

    expect(verifyTicket(ticket.code, null, staff.organizer).outcome).toBe("payment_required");
    expect(scan(ticket.code).outcome).toBe("payment_required");
    expect(getEvent(event.id).stats.checkedIn).toBe(0);

    const admitted = scan(ticket.code, { collectPayment: true, method: "upi" });
    expect(admitted.outcome).toBe("checked_in");
    expect(admitted.ticket?.paymentStatus).toBe("paid");
    expect(admitted.ticket?.checkedInAt).toBeTruthy();

    const again = scan(ticket.code);
    expect(again.outcome).toBe("already_checked_in");
    expect(again.ticket?.checkedInAt).toBe(admitted.ticket?.checkedInAt);
    expect(scan(ticket.code, { collectPayment: true }).outcome).toBe("already_checked_in");

    const stats = getEvent(event.id).stats;
    expect(stats.checkedIn).toBe(1);
    expect(stats.paid).toBe(1);

    // The charge was settled exactly once.
    const entries = listTransactions({ eventId: event.id });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "settled", method: "upi", amountCents: 50000 });
  });

  it("rejects unknown, malformed, wrong-event and cancelled tickets", () => {
    const event = publishedEvent(staff);
    const other = publishedEvent(staff, { title: "Other Event" });
    const ticket = registerForEvent(event.id, person(1), { actor: staff.organizer, payNow: "cash" });

    expect(scan("SKY-22222-22222").outcome).toBe("not_found");
    expect(scan("not a code").outcome).toBe("not_found");
    expect(scan(ticket.code, { eventId: other.id }).outcome).toBe("wrong_event");
    expect(getEvent(event.id).stats.checkedIn).toBe(0);

    const cancelled = registerForEvent(event.id, person(2));
    cancelTicket(cancelled.code, staff.organizer);
    expect(scan(cancelled.code).outcome).toBe("cancelled");

    expect(scan(ticket.code, { eventId: event.id }).outcome).toBe("checked_in");
  });

  it("is restricted to staff", () => {
    const event = publishedEvent(staff);
    const ticket = registerForEvent(event.id, person(1));
    expect(appError(() => checkIn({ code: ticket.code, eventId: null, collectPayment: true, method: "cash" }, null)).status).toBe(401);
    expect(appError(() => payTicket(ticket.code, "cash", null)).status).toBe(401);
    expect(appError(() => registerForEvent(event.id, person(2), { payNow: "cash" })).status).toBe(401);
  });

  it("refuses entry and records refunds when the event is cancelled", () => {
    const event = publishedEvent(staff);
    const paid = registerForEvent(event.id, person(1), { actor: staff.organizer, payNow: "cash" });
    const unpaid = registerForEvent(event.id, person(2));

    const change = setEventStatus(event.id, "cancelled", staff.organizer);
    expect(change.voidedPendingCount).toBe(1);
    expect(change.refundsDueCents).toBe(50000);
    expect(scan(paid.code).outcome).toBe("event_cancelled");
    expect(scan(unpaid.code).outcome).toBe("event_cancelled");

    // No live ticket is left pointing at a voided charge, and none counts as registered.
    const after = getEvent(event.id);
    expect(after.stats).toMatchObject({ registered: 0, pending: 0, paid: 0 });
    const orphans = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tickets t JOIN transactions x ON x.ticket_id = t.id AND x.source = 'ticket'
       WHERE t.status = 'valid' AND x.voided_at IS NOT NULL`,
    )!;
    expect(orphans.n).toBe(0);
    expect(appError(() => payTicket(unpaid.code, "cash", staff.organizer)).status).toBe(409);

    const finance = getEvent(event.id).finance;
    expect(finance.incomeSettledCents).toBe(50000);
    expect(finance.incomePendingCents).toBe(0);
    expect(finance.expensePendingCents).toBe(50000);
    expect(finance.projectedNetCents).toBe(0);
    expect(appError(() => setEventStatus(event.id, "published", staff.organizer)).code).toBe("event_cancelled");
  });

  it("records a refund when a paid ticket is cancelled", () => {
    const event = publishedEvent(staff);
    const ticket = registerForEvent(event.id, person(1), { actor: staff.organizer, payNow: "card" });
    expect(cancelTicket(ticket.code, staff.organizer).refundDueCents).toBe(50000);
    const refund = listTransactions({ type: "expense" });
    expect(refund).toHaveLength(1);
    expect(refund[0]).toMatchObject({ category: "refund", status: "pending", amountCents: 50000 });
  });
});

describe("finance", () => {
  it("validates transactions", () => {
    const ok = { type: "expense", category: "venue", amountCents: 100, occurredOn: "2026-10-10", description: "Hall" };
    expect(transactionInputSchema.safeParse(ok).success).toBe(true);
    expect(transactionInputSchema.safeParse({ ...ok, amountCents: 0 }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...ok, amountCents: -100 }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...ok, amountCents: 10.5 }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...ok, category: "tickets" }).success).toBe(false); // income category on an expense
    expect(transactionInputSchema.safeParse({ ...ok, occurredOn: "2026-02-30" }).success).toBe(false);
    expect(transactionInputSchema.safeParse({ ...ok, description: "" }).success).toBe(false);
    expect(appError(() => createTransaction(tx({ eventId: "evt_missing" }), staff.treasurer)).status).toBe(422);
  });

  it("keeps organizers out of the ledger: they file claims instead", () => {
    expect(appError(() => createTransaction(tx({}), null)).status).toBe(401);
    expect(appError(() => createTransaction(tx({ status: "settled" }), staff.organizer)).status).toBe(403);
    expect(appError(() => createTransaction(tx({ type: "income", category: "donation", status: "pending" }), staff.organizer)).status).toBe(403);
    expect(appError(() => createTransaction(tx({ status: "pending", counterparty: "Organizer" }), staff.organizer)).status).toBe(403);
    const claim = createTransaction(tx({ status: "pending", counterparty: "Supplier" }), staff.treasurer);
    expect(claim.status).toBe("pending");
    expect(appError(() => settleTransaction(claim.id, "bank", staff.organizer)).status).toBe(403);
    expect(settleTransaction(claim.id, "bank", staff.treasurer).status).toBe("settled");
    expect(appError(() => settleTransaction(claim.id, "bank", staff.treasurer)).code).toBe("not_pending");
  });

  it("keeps collected and pending money apart and reconciles with the ledger", () => {
    const gala = publishedEvent(staff, { title: "Gala" });
    registerForEvent(gala.id, person(1), { actor: staff.organizer, payNow: "upi" }); // 500 collected
    registerForEvent(gala.id, person(2), { actor: staff.organizer, payNow: "cash" }); // 500 collected
    registerForEvent(gala.id, person(3)); // 500 pending
    createTransaction(tx({ type: "income", category: "sponsorship", amountCents: 200000, eventId: gala.id }), staff.treasurer);
    createTransaction(tx({ category: "venue", amountCents: 150000, eventId: gala.id }), staff.treasurer);
    createTransaction(tx({ category: "catering", amountCents: 80000, status: "pending", eventId: gala.id }), staff.treasurer);
    createTransaction(tx({ type: "income", category: "donation", amountCents: 30000 }), staff.treasurer); // not tied to an event
    const mistake = createTransaction(tx({ category: "supplies", amountCents: 999900 }), staff.treasurer);
    voidTransaction(mistake.id, "Entered twice", staff.treasurer);

    const f = getEvent(gala.id).finance;
    expect(f.ticketIncomeSettledCents).toBe(100000);
    expect(f.ticketIncomePendingCents).toBe(50000);
    expect(f.incomeSettledCents).toBe(300000);
    expect(f.incomePendingCents).toBe(50000);
    expect(f.expenseSettledCents).toBe(150000);
    expect(f.expensePendingCents).toBe(80000);
    expect(f.netCents).toBe(150000); // 3,000 collected − 1,500 paid; pending items excluded
    expect(f.projectedNetCents).toBe(120000); // + 500 pending − 800 owed

    // Independent recomputation straight from the ledger rows.
    const rows = listTransactions();
    const sum = (type: string, status: string, eventId?: string) =>
      rows
        .filter((r) => r.type === type && r.status === status && (eventId === undefined || r.eventId === eventId))
        .reduce((s, r) => s + r.amountCents, 0);
    expect(rows.some((r) => r.id === mistake.id)).toBe(false);
    expect(f.incomeSettledCents).toBe(sum("income", "settled", gala.id));
    expect(f.expenseSettledCents).toBe(sum("expense", "settled", gala.id));

    const summary = getFinanceSummary();
    expect(summary.incomeSettledCents).toBe(sum("income", "settled"));
    expect(summary.incomePendingCents).toBe(sum("income", "pending"));
    expect(summary.expenseSettledCents).toBe(sum("expense", "settled"));
    expect(summary.expensePendingCents).toBe(sum("expense", "pending"));
    expect(summary.netCents).toBe(330000 - 150000);
    expect(summary.transactionCount).toBe(rows.length);

    // Category, month and event breakdowns each add back up to the totals.
    const total = (items: { settledCents?: number; incomeSettledCents?: number }[], key: "settledCents" | "incomeSettledCents") =>
      items.reduce((s, i) => s + (i[key] ?? 0), 0);
    expect(total(summary.byCategory.filter((c) => c.type === "income"), "settledCents")).toBe(summary.incomeSettledCents);
    expect(total(summary.byEvent, "incomeSettledCents")).toBe(summary.incomeSettledCents);
    expect(summary.byEvent.reduce((s, e) => s + e.netCents, 0)).toBe(summary.netCents);
    expect(summary.byMonth.reduce((s, m) => s + m.netCents, 0)).toBe(summary.netCents);
    expect(summary.byEvent.find((e) => e.eventId === null)?.incomeSettledCents).toBe(30000);
  });

  it("does not let ticket charges be edited or voided by hand", () => {
    const event = publishedEvent(staff);
    const ticket = registerForEvent(event.id, person(1));
    const [charge] = listTransactions({ eventId: event.id });
    expect(appError(() => voidTransaction(charge.id, "Trying to hide it", staff.treasurer)).code).toBe("linked_entry");
    // Settling it from the finance screen also marks the ticket paid.
    settleTransaction(charge.id, "bank", staff.treasurer);
    expect(verifyTicket(ticket.code, null, staff.organizer).outcome).toBe("valid");
  });
});
