import { beforeEach, describe, expect, it } from "vitest";
import {
  CAN,
  memberInputSchema,
  orderInputSchema,
  productInputSchema,
  taskInputSchema,
  transactionInputSchema,
  type Member,
  type Role,
  type SessionUser,
} from "@/lib/contracts";
import { listCommitteeAccounts, setCommitteeAccountStatus } from "@/server/admin-setup";
import { completeSetup, createSetupToken, createUser, getSessionUser, login } from "@/server/auth";
import { get, run, today } from "@/server/db";
import { createEvent, setEventStatus, updateEvent } from "@/server/services/events";
import { createTransaction, listTransactions, settleTransaction, voidTransaction } from "@/server/services/finance";
import { collectDues, createMember, issueSetupLink } from "@/server/services/members";
import { actOnOrder, createProduct, listOrders, placeOrder, setStock } from "@/server/services/merch";
import { resolveOrderPayment } from "@/server/services/order-payments";
import {
  eventFor,
  viewDashboard,
  viewEvent,
  viewEvents,
  viewFinanceSummary,
  viewMember,
  viewMembers,
  viewOrders,
  viewTransactions,
} from "@/server/services/staff-views";
import { createTask, deleteTask, transitionTask, updateTask } from "@/server/services/tasks";
import { cancelTicket, checkIn, payTicket, registerForEvent, undoCheckIn, verifyTicket } from "@/server/services/tickets";
import { listVolunteerRequests, requestToVolunteer, reviewVolunteerRequest } from "@/server/services/volunteering";
import { appError, eventInput, freshDb, person, publishedEvent, type Staff } from "./helpers";

/**
 * The committee authorization policy, role by role:
 *
 *   president (admin)      everything
 *   treasurer              finance, payments, member records, merchandise, claims
 *   event handler          events, the door, volunteer approvals; no member
 *   (organizer)            records, no ledger, no taking or refunding money
 *
 * Every check here calls the service a route calls, with a session user, so it
 * holds whatever the UI shows.
 */

let staff: Staff;
let member: Member;
let event: Awaited<ReturnType<typeof publishedEvent>>;

const ROLE_NAMES = ["admin", "treasurer", "organizer"] as const satisfies readonly Role[];
const indexOf = (actor: SessionUser) => ROLE_NAMES.indexOf(actor.role as Role);
const asMember = (m: Member): SessionUser => ({ id: m.id, name: m.name, email: m.email, role: "member", memberId: m.id, memberNo: m.memberNo });

/** 200 for allowed, the error status for refused. */
const status = async (fn: () => unknown): Promise<number> => {
  try {
    await fn();
    return 200;
  } catch (error) {
    return (error as { status?: number }).status ?? 500;
  }
};

/** Runs `fn` as each role and returns who was allowed. Anyone refused must be refused with 403. */
async function allowed(fn: (actor: SessionUser) => unknown): Promise<Role[]> {
  const result: Role[] = [];
  for (const role of ROLE_NAMES) {
    const code = await status(() => fn(staff[role]));
    if (code === 200) result.push(role);
    else expect(code, `${role} should be refused with 403`).toBe(403);
  }
  return result;
}

const expense = (overrides: Record<string, unknown> = {}) =>
  transactionInputSchema.parse({
    type: "expense",
    category: "venue",
    amountCents: 20000,
    status: "pending",
    occurredOn: today(),
    description: "Hall deposit",
    eventId: event.id,
    ...overrides,
  });

const tee = () =>
  productInputSchema.parse({ name: "Club Tee", priceCents: 40000, memberPriceCents: 35000, variants: [{ size: "M", stock: 0 }] });

beforeEach(async () => {
  staff = await freshDb();
  member = await createMember(memberInputSchema.parse({ name: "Mira Member", email: "mira@campus.example", duesPaid: true }), staff.admin);
  event = await publishedEvent(staff, { title: "Winter Gala" });
});

describe("the permission table", () => {
  it("matches the approved policy", () => {
    expect(CAN.manageFinance).toEqual(["admin", "treasurer"]);
    expect(CAN.manageMembers).toEqual(["admin", "treasurer"]);
    expect(CAN.manageMerch).toEqual(["admin", "treasurer"]);
    expect(CAN.collectPayment).toEqual(["admin", "treasurer"]);
    expect(CAN.manageEvents).toEqual(["admin", "organizer"]);
    expect(CAN.reviewVolunteers).toEqual(["admin", "organizer"]);
    expect(CAN.manageAccounts).toEqual(["admin"]);
    expect(CAN.processRefunds).toEqual(["admin"]);
    expect(CAN.cancelEvents).toEqual(["admin"]);
    // The event handler appears in nothing that touches money, members or accounts.
    for (const action of ["manageFinance", "manageMembers", "manageMerch", "collectPayment", "manageAccounts"] as const) {
      expect(CAN[action] as readonly string[]).not.toContain("organizer");
    }
  });
});

describe("reading member records", () => {
  it("is for the president and the treasurer: the list and one member", async () => {
    expect(await allowed((actor) => viewMembers(actor))).toEqual(["admin", "treasurer"]);
    expect(await allowed((actor) => viewMember(member.id, actor))).toEqual(["admin", "treasurer"]);
    expect((await viewMember(member.id, staff.treasurer)).email).toBe("mira@campus.example");
  });

  it("is refused to members and to nobody at all", async () => {
    expect(await status(() => viewMembers(asMember(member)))).toBe(403);
    expect(await status(() => viewMember(member.id, asMember(member)))).toBe(403);
    expect(await status(() => viewMembers(null))).toBe(401);
  });
});

describe("reading finance and payment records", () => {
  beforeEach(async () => {
    await createTransaction(expense({ status: "settled" }), staff.treasurer);
    await registerForEvent(event.id, person(1), { actor: staff.treasurer, payNow: "cash" });
  });

  it("is for the president and the treasurer: ledger, filtered ledger, summary, orders", async () => {
    expect(await allowed((actor) => viewTransactions({}, actor))).toEqual(["admin", "treasurer"]);
    expect(await allowed((actor) => viewTransactions({ eventId: event.id }, actor))).toEqual(["admin", "treasurer"]);
    expect(await allowed((actor) => viewFinanceSummary(actor))).toEqual(["admin", "treasurer"]);
    expect(await allowed((actor) => viewOrders(actor))).toEqual(["admin", "treasurer"]);
    expect((await viewTransactions({ eventId: event.id }, staff.treasurer)).length).toBe(2);
    expect(await status(() => viewTransactions({}, asMember(member)))).toBe(403);
    expect(await status(() => viewFinanceSummary(null))).toBe(401);
  });

  it("gives the event handler events without any ledger figure", async () => {
    const mine = await viewEvent(event.id, staff.organizer);
    expect(mine.event.finance).toBeNull();
    expect(mine.breakEven).toBeNull();
    expect(mine.profitTarget).toBeNull();
    // They still run the door: who is registered, and whether each ticket is paid.
    expect(mine.tickets.map((t) => [t.attendeeName, t.paymentStatus])).toEqual([["Student 1", "paid"]]);
    expect(mine.event.stats.registered).toBe(1);

    expect((await viewEvents(staff.organizer)).every((e) => e.finance === null)).toBe(true);
    expect(eventFor(event, staff.organizer).finance).toBeNull();
    expect(JSON.stringify(mine)).not.toMatch(/incomeSettledCents|expenseSettledCents|netCents/);
  });

  it("gives the president and the treasurer the full event", async () => {
    for (const actor of [staff.admin, staff.treasurer]) {
      const full = await viewEvent(event.id, actor);
      expect(full.event.finance).toMatchObject({ incomeSettledCents: 50000, expenseSettledCents: 20000 });
      expect(full.breakEven).not.toBeNull();
      expect((await viewEvents(actor))[0].finance).not.toBeNull();
    }
    expect(await status(() => viewEvent(event.id, asMember(member)))).toBe(403);
    expect(await status(() => viewEvents(null))).toBe(401);
  });

  it("gives the event handler a dashboard with no money and no member counts", async () => {
    await registerForEvent(event.id, person(2)); // an unpaid ticket: a money alert for those who may see it
    await createProduct(tee(), staff.treasurer); // out of stock: a merchandise alert
    await createTask(taskInputSchema.parse({ title: "Book the hall", dueOn: "2000-01-01" }), staff.organizer);

    for (const actor of [staff.admin, staff.treasurer]) {
      const full = await viewDashboard(actor);
      expect(full.finance).not.toBeNull();
      expect(full.members).toMatchObject({ total: 1 });
      expect(full.eventPerformance[0].netCents).toBe(30000);
      expect(full.cashflow.length).toBeGreaterThan(0);
      expect(full.alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(["low_stock", "unpaid_tickets"]));
    }
    // Volunteer tasks are not the treasurer's: no task figures and no task alert.
    const president = await viewDashboard(staff.admin);
    expect(president.tasks).toMatchObject({ overdue: 1 });
    expect(president.alerts.map((a) => a.kind)).toContain("overdue_tasks");
    const treasurers = await viewDashboard(staff.treasurer);
    expect(treasurers.tasks).toBeNull();
    expect(treasurers.alerts.map((a) => a.kind)).not.toContain("overdue_tasks");

    const reduced = await viewDashboard(staff.organizer);
    expect(reduced.finance).toBeNull();
    expect(reduced.members).toBeNull();
    expect(reduced.cashflow).toEqual([]);
    expect(reduced.eventPerformance[0]).toMatchObject({ registered: 2, netCents: null, incomeSettledCents: null, expenseSettledCents: null });
    expect(reduced.alerts.map((a) => a.kind)).toEqual(["overdue_tasks"]);
    expect(reduced.events.total).toBe(1);
    expect(reduced.tasks?.overdue).toBe(1);

    expect(await status(() => viewDashboard(asMember(member)))).toBe(403);
  });
});

describe("ticket payments", () => {
  it("are recorded by the president and the treasurer, never the event handler", async () => {
    for (const [n, role] of ROLE_NAMES.entries()) {
      const ticket = await registerForEvent(event.id, person(n + 1));
      expect(await status(() => payTicket(ticket.code, "cash", staff[role]))).toBe(role === "organizer" ? 403 : 200);
    }
    expect(await allowed((actor) => registerForEvent(event.id, person(10 + indexOf(actor)), { actor, payNow: "upi" }))).toEqual(["admin", "treasurer"]);
    // Refused before anything was written: the organizer's attempt left no ticket behind.
    expect((await viewEvent(event.id, staff.admin)).tickets.length).toBe(5);
  });

  it("cannot be collected at the door by the event handler, who can still check paid tickets in", async () => {
    const unpaid = await registerForEvent(event.id, person(1));
    const refused = await appError(() => checkIn({ code: unpaid.code, eventId: event.id, collectPayment: true, method: "cash" }, staff.organizer));
    expect(refused.status).toBe(403);
    expect(await get("SELECT payment_status, checked_in_at FROM tickets WHERE code = ?", unpaid.code)).toEqual({ payment_status: "pending", checked_in_at: null });

    // Without asking to collect, the door is told payment is needed and nothing changes.
    expect((await checkIn({ code: unpaid.code, eventId: event.id, collectPayment: false, method: "cash" }, staff.organizer)).outcome).toBe("payment_required");
    expect((await verifyTicket(unpaid.code, event.id, staff.organizer)).outcome).toBe("payment_required");

    await payTicket(unpaid.code, "cash", staff.treasurer);
    expect((await checkIn({ code: unpaid.code, eventId: event.id, collectPayment: false, method: "cash" }, staff.organizer)).outcome).toBe("checked_in");
    expect((await undoCheckIn(unpaid.code, staff.organizer)).checkedInAt).toBeNull();

    const second = await registerForEvent(event.id, person(2));
    expect((await checkIn({ code: second.code, eventId: event.id, collectPayment: true, method: "upi" }, staff.admin)).outcome).toBe("checked_in");
  });

  it("are refunded by cancelling a paid ticket: the president only", async () => {
    for (const [n, role] of ROLE_NAMES.entries()) {
      const paid = await registerForEvent(event.id, person(n + 1), { actor: staff.treasurer, payNow: "cash" });
      expect(await status(() => cancelTicket(paid.code, staff[role]))).toBe(role === "admin" ? 200 : 403);
    }
    // The two refused attempts changed nothing: those tickets are still valid and no refund was recorded for them.
    expect((await listTransactions({})).filter((t) => t.category === "refund").length).toBe(1);
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE status = 'valid'"))!.n).toBe(2);
  });

  it("refunds owed are paid out or voided by the president only", async () => {
    const refundFor = async (n: number) => {
      const paid = await registerForEvent(event.id, person(n), { actor: staff.treasurer, payNow: "cash" });
      await cancelTicket(paid.code, staff.admin);
      return (await listTransactions({})).find((t) => t.source === "refund" && t.ticketId === paid.id)!;
    };
    const first = await refundFor(1);
    expect(await allowed((actor) => settleTransaction(first.id, "bank", actor))).toEqual(["admin"]);
    expect((await listTransactions({})).find((t) => t.id === first.id)!.status).toBe("settled");

    const second = await refundFor(2);
    expect(await status(() => voidTransaction(second.id, "Changed their mind", staff.treasurer))).toBe(403);
    expect(await status(() => voidTransaction(second.id, "Changed their mind", staff.organizer))).toBe(403);
    expect((await voidTransaction(second.id, "Kept the ticket credit instead", staff.admin)).voidedAt).not.toBeNull();
  });

  it("a refund owed for a cancelled merchandise order is also paid out by the president only", async () => {
    const product = await createProduct(productInputSchema.parse({ name: "Mug", priceCents: 9000, memberPriceCents: 8000, variants: [{ size: "One", stock: 3 }] }), staff.treasurer);
    await placeOrder(orderInputSchema.parse({ productId: product.id, variantId: product.variants[0].id, quantity: 1, name: "Buyer One", email: "buyer1@campus.example" }));
    const order = (await listOrders())[0];
    await actOnOrder(order.id, "pay", "cash", staff.treasurer);
    expect(await status(() => actOnOrder(order.id, "cancel", "cash", staff.treasurer))).toBe(403);
    expect(await status(() => actOnOrder(order.id, "cancel", "cash", staff.organizer))).toBe(403);
    expect((await listOrders())[0].status).toBe("placed");
    expect((await listTransactions({})).filter((t) => t.source === "refund").length).toBe(0);
    expect((await actOnOrder(order.id, "cancel", "cash", staff.admin)).refundDueCents).toBe(9000);
    const refund = (await listTransactions({})).find((t) => t.source === "refund" && t.orderId === order.id)!;
    expect(await allowed((actor) => settleTransaction(refund.id, "bank", actor))).toEqual(["admin"]);
  });

  it("the treasurer still cancels an unpaid merchandise order, which owes no refund", async () => {
    const product = await createProduct(productInputSchema.parse({ name: "Cap", priceCents: 5000, memberPriceCents: 4000, variants: [{ size: "One", stock: 2 }] }), staff.treasurer);
    await placeOrder(orderInputSchema.parse({ productId: product.id, variantId: product.variants[0].id, quantity: 1, name: "Buyer Two", email: "buyer2@campus.example" }));
    const order = (await listOrders())[0];
    expect(await status(() => actOnOrder(order.id, "cancel", "cash", staff.organizer))).toBe(403);
    expect((await actOnOrder(order.id, "cancel", "cash", staff.treasurer)).refundDueCents).toBe(0);
  });

  it("only the president marks an online order payment as refunded", async () => {
    // The role is checked before the record is looked up, so an unknown id is enough.
    expect(await status(() => resolveOrderPayment("opy_missing", "Refunded in the dashboard", staff.treasurer))).toBe(403);
    expect(await status(() => resolveOrderPayment("opy_missing", "Refunded in the dashboard", staff.organizer))).toBe(403);
    expect(await status(() => resolveOrderPayment("opy_missing", "Refunded in the dashboard", null))).toBe(401);
    expect(await status(() => resolveOrderPayment("opy_missing", "Refunded in the dashboard", staff.admin))).toBe(404);
  });

  it("leave cancelling an unpaid ticket to those who manage events", async () => {
    for (const [n, role] of ROLE_NAMES.entries()) {
      const unpaid = await registerForEvent(event.id, person(n + 1));
      expect(await status(() => cancelTicket(unpaid.code, staff[role]))).toBe(role === "treasurer" ? 403 : 200);
    }
    expect((await listTransactions({})).filter((t) => t.category === "refund").length).toBe(0);
  });
});

describe("what the treasurer does not do", () => {
  it("is in the permission table: no door, no volunteer tasks, no adding members by hand", () => {
    expect(CAN.checkIn).toEqual(["admin", "organizer"]);
    expect(CAN.manageTasks).toEqual(["admin", "organizer"]);
    expect(CAN.addMembers).toEqual(["admin"]);
    // Everything the treasurer is for is untouched.
    for (const action of ["manageFinance", "manageMembers", "manageMerch", "collectPayment", "fileExpenseClaim"] as const) {
      expect(CAN[action] as readonly string[]).toContain("treasurer");
    }
  });

  it("cannot look a ticket up at the door or check anyone in, even to take a payment", async () => {
    const ticket = await registerForEvent(event.id, person(1));
    expect(await allowed((actor) => verifyTicket(ticket.code, event.id, actor))).toEqual(["admin", "organizer"]);
    expect(await status(() => checkIn({ code: ticket.code, eventId: event.id, collectPayment: false, method: "cash" }, staff.treasurer))).toBe(403);
    expect(await status(() => checkIn({ code: ticket.code, eventId: event.id, collectPayment: true, method: "cash" }, staff.treasurer))).toBe(403);
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE checked_in_at IS NOT NULL"))!.n).toBe(0);
    expect(await status(() => checkIn({ code: ticket.code, eventId: event.id, collectPayment: false, method: "cash" }, asMember(member)))).toBe(403);
    // The treasurer still records the payment, from the event page.
    expect((await payTicket(ticket.code, "cash", staff.treasurer)).paymentStatus).toBe("paid");
    expect(await status(() => checkIn({ code: ticket.code, eventId: event.id, collectPayment: false, method: "cash" }, staff.organizer))).toBe(200);
  });

  it("cannot create, edit, move or delete volunteer tasks", async () => {
    const input = taskInputSchema.parse({ title: "Book the hall" });
    expect(await allowed((actor) => createTask(input, actor))).toEqual(["admin", "organizer"]);
    const task = await createTask(input, staff.organizer);
    expect(await status(() => updateTask(task.id, taskInputSchema.parse({ title: "Renamed" }), staff.treasurer))).toBe(403);
    expect(await status(() => transitionTask(task.id, "start", staff.treasurer))).toBe(403);
    expect(await status(() => deleteTask(task.id, staff.treasurer))).toBe(403);
    expect(await status(() => listVolunteerRequests(staff.treasurer))).toBe(403);
    expect((await get<{ title: string; status: string }>("SELECT title, status FROM tasks WHERE id = ?", task.id))).toEqual({ title: "Book the hall", status: "todo" });
    expect((await transitionTask(task.id, "start", staff.admin)).status).toBe("in_progress");
  });

  it("cannot add a member by hand; only the president can", async () => {
    const input = (n: number) => memberInputSchema.parse({ name: `New Member ${n}`, email: `new${n}@campus.example`, duesPaid: false });
    expect(await status(() => createMember(input(1), staff.treasurer))).toBe(403);
    expect(await status(() => createMember(input(1), staff.organizer))).toBe(403);
    expect(await status(() => createMember(input(1), asMember(member)))).toBe(403);
    expect(await status(() => createMember(input(1), null))).toBe(401);
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM members"))!.n).toBe(1);
    expect((await createMember(input(2), staff.admin)).memberNo).toBe("SKY-M-0002");
  });

  it("still sees member records, dues and status, collects dues and issues password links", async () => {
    const unpaid = await createMember(memberInputSchema.parse({ name: "Uma Unpaid", email: "uma@campus.example", duesPaid: false }), staff.admin);
    const listed = await viewMembers(staff.treasurer);
    expect(listed.map((m) => [m.memberNo, m.status]).sort()).toEqual([["SKY-M-0001", "active"], ["SKY-M-0002", "unpaid"]]);
    expect((await viewMember(unpaid.id, staff.treasurer)).duesOwedCents).toBeGreaterThan(0);
    expect((await collectDues(unpaid.id, "cash", staff.treasurer)).status).toBe("active");
    expect((await issueSetupLink(unpaid.id, staff.treasurer)).memberNo).toBe("SKY-M-0002");
  });
});

describe("what each role keeps", () => {
  it("the treasurer keeps every financial operation", async () => {
    const entry = await createTransaction(expense(), staff.treasurer);
    expect((await settleTransaction(entry.id, "bank", staff.treasurer)).status).toBe("settled");
    const owing = await createMember(memberInputSchema.parse({ name: "Omar Owing", email: "omar@campus.example", duesPaid: false }), staff.admin);
    expect((await collectDues(owing.id, "cash", staff.treasurer)).duesOwedCents).toBe(0);
    const product = await createProduct(tee(), staff.treasurer);
    expect((await setStock(product.id, product.variants[0].id, 7, staff.treasurer)).variants[0].stock).toBe(7);
  });

  it("the event handler is refused every one of them", async () => {
    const entry = await createTransaction(expense(), staff.treasurer);
    const product = await createProduct(tee(), staff.treasurer);
    const refusals = [
      () => createTransaction(expense(), staff.organizer),
      () => settleTransaction(entry.id, "bank", staff.organizer),
      () => createMember(memberInputSchema.parse({ name: "Nope", email: "nope@campus.example", duesPaid: true }), staff.organizer),
      () => collectDues(member.id, "cash", staff.organizer),
      () => createProduct(tee(), staff.organizer),
      () => setStock(product.id, product.variants[0].id, 5, staff.organizer),
    ];
    for (const refusal of refusals) expect(await status(refusal)).toBe(403);
  });

  it("the event handler creates, edits, publishes and unpublishes events; the treasurer does none of it", async () => {
    expect(await allowed((actor) => createEvent(eventInput({ title: `By ${actor.role}` }), actor))).toEqual(["admin", "organizer"]);
    const draft = await createEvent(eventInput({ title: "Open Mic" }), staff.organizer);
    expect(await allowed((actor) => updateEvent(draft.id, eventInput({ title: "Open Mic Night" }), actor))).toEqual(["admin", "organizer"]);
    expect(await status(() => setEventStatus(draft.id, "published", staff.treasurer))).toBe(403);
    expect((await setEventStatus(draft.id, "published", staff.organizer)).event.status).toBe("published");
    expect((await setEventStatus(draft.id, "draft", staff.organizer)).event.status).toBe("draft");
  });

  it("only the president cancels a whole event", async () => {
    await registerForEvent(event.id, person(1), { actor: staff.treasurer, payNow: "cash" });
    expect(await status(() => setEventStatus(event.id, "cancelled", staff.organizer))).toBe(403);
    expect(await status(() => setEventStatus(event.id, "cancelled", staff.treasurer))).toBe(403);
    // Refused before anything changed: still published, ticket still valid, no refund recorded.
    expect((await viewEvent(event.id, staff.admin)).event.status).toBe("published");
    expect((await listTransactions({})).filter((t) => t.category === "refund").length).toBe(0);

    const change = await setEventStatus(event.id, "cancelled", staff.admin);
    expect([change.event.status, change.refundsDueCents]).toEqual(["cancelled", 50000]);
  });

  it("volunteer requests are decided by the president and the event handler, not the treasurer", async () => {
    const task = await createTask(taskInputSchema.parse({ title: "Welcome desk", eventId: event.id, volunteerSlots: 3 }), staff.organizer);
    const helpers: Member[] = [member];
    for (const n of [1, 2]) {
      helpers.push(await createMember(memberInputSchema.parse({ name: `Helper ${n}`, email: `helper${n}@campus.example`, duesPaid: true }), staff.admin));
    }
    const requests: { id: string }[] = [];
    for (const m of helpers) requests.push(await requestToVolunteer(m.id, task.id));

    expect(await allowed((actor) => listVolunteerRequests(actor))).toEqual(["admin", "organizer"]);
    // One request each: the president's and the organizer's are approved, the treasurer's attempt is refused.
    expect(await allowed((actor) => reviewVolunteerRequest(requests[indexOf(actor)].id, { action: "approve" }, actor))).toEqual(["admin", "organizer"]);
    expect(await status(() => reviewVolunteerRequest(requests[1].id, { action: "approve" }, asMember(member)))).toBe(403);
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM volunteer_requests WHERE status = 'approved'"))!.n).toBe(2);
  });
});

describe("committee accounts", () => {
  it("are listed and changed by the president only", async () => {
    expect(await allowed((actor) => listCommitteeAccounts(actor))).toEqual(["admin"]);
    expect(await status(() => setCommitteeAccountStatus(staff.organizer.id, "disable", staff.treasurer))).toBe(403);
    expect(await status(() => setCommitteeAccountStatus(staff.treasurer.id, "disable", staff.organizer))).toBe(403);
    expect(await status(() => setCommitteeAccountStatus(staff.treasurer.id, "disable", asMember(member)))).toBe(403);
    expect(await status(() => listCommitteeAccounts(null))).toBe(401);
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NOT NULL"))!.n).toBe(0);

    const list = await listCommitteeAccounts(staff.admin);
    expect(list.map((a) => `${a.role}:${a.disabledAt}:${a.isYou}`).sort()).toEqual(["admin:null:true", "organizer:null:false", "treasurer:null:false"]);
    expect(JSON.stringify(list)).not.toMatch(/password|hash|scrypt/i);
  });

  it("disabling ends every session and stops sign-in, without removing anything the account recorded", async () => {
    const entry = await createTransaction(expense({ status: "settled" }), staff.treasurer);
    const first = await login("treasurer@test.example", "password-1");
    const second = await login("treasurer@test.example", "password-1");
    expect((await getSessionUser(first.token))?.role).toBe("treasurer");

    const disabled = await setCommitteeAccountStatus(staff.treasurer.id, "disable", staff.admin);
    expect(disabled.disabledAt).not.toBeNull();

    expect(await getSessionUser(first.token)).toBeNull();
    expect(await getSessionUser(second.token)).toBeNull();
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", staff.treasurer.id))!.n).toBe(0);
    // The same answer as a wrong password, so it says nothing about the account.
    const refused = await appError(() => login("treasurer@test.example", "password-1"));
    expect([refused.status, refused.code]).toEqual([401, "invalid_credentials"]);

    // The ledger entry and its author are untouched, and the account row is still there.
    expect(await get("SELECT created_by, voided_at FROM transactions WHERE id = ?", entry.id)).toEqual({ created_by: staff.treasurer.id, voided_at: null });
    expect((await viewFinanceSummary(staff.admin)).expenseSettledCents).toBe(20000);
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n).toBe(3);

    expect((await appError(() => setCommitteeAccountStatus(staff.treasurer.id, "disable", staff.admin))).code).toBe("already_disabled");
  });

  it("a session row that survives is still refused while the account is disabled", async () => {
    const session = await login("organizer@test.example", "password-1");
    const row = (await get<{ token_hash: string; user_id: string; expires_at: string; created_at: string }>(
      "SELECT token_hash, user_id, expires_at, created_at FROM sessions WHERE user_id = ?",
      staff.organizer.id,
    ))!;
    await setCommitteeAccountStatus(staff.organizer.id, "disable", staff.admin);
    await run("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", row.token_hash, row.user_id, row.expires_at, row.created_at);
    expect(await getSessionUser(session.token)).toBeNull();
  });

  it("enabling restores sign-in with the same password", async () => {
    await setCommitteeAccountStatus(staff.organizer.id, "disable", staff.admin);
    expect((await appError(() => login("organizer@test.example", "password-1"))).status).toBe(401);
    const enabled = await setCommitteeAccountStatus(staff.organizer.id, "enable", staff.admin);
    expect(enabled.disabledAt).toBeNull();
    expect((await login("organizer@test.example", "password-1")).user.role).toBe("organizer");
    expect((await appError(() => setCommitteeAccountStatus(staff.organizer.id, "enable", staff.admin))).code).toBe("not_disabled");
  });

  it("a president cannot disable themselves, and a disabled president cannot act", async () => {
    expect((await appError(() => setCommitteeAccountStatus(staff.admin.id, "disable", staff.admin))).code).toBe("own_account");
    expect((await appError(() => setCommitteeAccountStatus("usr_missing", "disable", staff.admin))).status).toBe(404);

    const second = await createUser({ email: "second@test.example", name: "Second President", role: "admin", password: "password-1" });
    await setCommitteeAccountStatus(second.id, "disable", staff.admin);
    // A stale session object for the disabled president is refused, so two presidents cannot disable each other.
    expect(await status(() => setCommitteeAccountStatus(staff.admin.id, "disable", second))).toBe(403);
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL"))!.n).toBe(1);
  });

  it("a disabled account that is also a member can still sign in as that member", async () => {
    const both = await createMember(memberInputSchema.parse({ name: "Organizer", email: "organizer@test.example", duesPaid: true }), staff.admin);
    await completeSetup((await createSetupToken(both.id, staff.admin.id)).token, "a-member-password");
    await setCommitteeAccountStatus(staff.organizer.id, "disable", staff.admin);
    expect((await login("organizer@test.example", "a-member-password")).user.role).toBe("member");
    expect((await appError(() => login("organizer@test.example", "password-1"))).status).toBe(401);
  });
});
