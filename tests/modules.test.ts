import { beforeEach, describe, expect, it } from "vitest";
import { SETTINGS, memberInputSchema, productInputSchema, taskInputSchema } from "@/lib/contracts";
import { addDays } from "@/lib/dates";
import { get, setClock, today } from "@/server/db";
import { seedDemoData } from "@/server/seed";
import { createAnnouncement, listAnnouncements, listPublicAnnouncements } from "@/server/services/announcements";
import { getDashboard } from "@/server/services/dashboard";
import { getEvent, listEvents } from "@/server/services/events";
import { getFinanceSummary, listTransactions } from "@/server/services/finance";
import {
  collectDues,
  createMember,
  getMember,
  listMembers,
  renewMember,
} from "@/server/services/members";
import { actOnOrder, createProduct, getProduct, listOrders, listPublicProducts, placeOrder, setStock } from "@/server/services/merch";
import { createTask, listTasks, transitionTask } from "@/server/services/tasks";
import { registerForEvent } from "@/server/services/tickets";
import { appError, freshDb, person, publishedEvent, type Staff } from "./helpers";

let staff: Staff;
beforeEach(() => {
  staff = freshDb();
});

const member = (n: number, overrides: Record<string, unknown> = {}) =>
  memberInputSchema.parse({ name: `Member ${n}`, email: `member${n}@campus.example`, duesPaid: true, ...overrides });

describe("memberships", () => {
  it("activates a member only once dues are collected", () => {
    const paid = createMember(member(1), staff.treasurer);
    expect(paid.memberNo).toBe("SKY-M-0001");
    expect(paid.status).toBe("active");
    expect(paid.paidUntilOn).toBe(`${today().slice(0, 4)}-12-31`);

    const joined = createMember(member(2, { name: "Walk Up", duesPaid: false }), staff.treasurer);
    expect(joined.memberNo).toBe("SKY-M-0002");
    expect(joined.duesOwedCents).toBe(SETTINGS.membershipFeeCents);
    const unpaid = listMembers().find((m) => m.memberNo === "SKY-M-0002")!;
    expect(unpaid.status).toBe("unpaid");

    // Dues: one collected, one still owed. The ledger says the same.
    const summary = getFinanceSummary();
    expect(summary.incomeSettledCents).toBe(SETTINGS.membershipFeeCents);
    expect(summary.incomePendingCents).toBe(SETTINGS.membershipFeeCents);

    expect(collectDues(unpaid.id, "upi", staff.treasurer).status).toBe("active");
    expect(getFinanceSummary().incomePendingCents).toBe(0);
    expect(appError(() => collectDues(unpaid.id, "upi", staff.treasurer)).code).toBe("nothing_owed");
  });

  it("rejects duplicate emails and unauthorised changes", () => {
    createMember(member(1), staff.treasurer);
    expect(appError(() => createMember(member(1), staff.treasurer)).code).toBe("email_taken");
    expect(appError(() => createMember(member(1, { email: "MEMBER1@campus.example" }), staff.treasurer)).code).toBe("email_taken");
    expect(appError(() => createMember(member(2), staff.organizer)).status).toBe(403);
    expect(appError(() => createMember(member(2), null)).status).toBe(401);
  });

  it("flags memberships that are ending and marks them lapsed afterwards", () => {
    const m = createMember(member(1, { expiresOn: addDays(today(), 10) }), staff.treasurer);
    expect(m.status).toBe("expiring");
    expect(m.daysToExpiry).toBe(10);
    setClock(() => new Date(Date.now() + 11 * 86_400_000));
    expect(listMembers()[0].status).toBe("lapsed");
    setClock(null);
    expect(appError(() => createMember(member(2, { expiresOn: addDays(today(), -1) }), staff.treasurer)).status).toBe(422);
  });

  it("renews from the day after the current term and keeps the history", () => {
    const m = createMember(member(1), staff.treasurer);
    const year = Number(today().slice(0, 4));
    const renewed = renewMember(m.id, { duesPaid: true, method: "upi" }, staff.treasurer);
    expect(renewed.paidUntilOn).toBe(`${year + 1}-12-31`);
    const detail = getMember(m.id);
    expect(detail.periods.map((p) => p.kind)).toEqual(["renewal", "new"]);
    expect(detail.periods[0].startsOn).toBe(`${year + 1}-01-01`);
    expect(listTransactions({ category: "dues" })).toHaveLength(2);

    const owing = renewMember(m.id, { duesPaid: false, method: "cash" }, staff.treasurer);
    expect(owing.duesOwedCents).toBe(SETTINGS.membershipFeeCents);
    expect(owing.paidUntilOn).toBe(`${year + 1}-12-31`); // an unpaid term extends nothing
    expect(appError(() => renewMember(m.id, { duesPaid: true, method: "cash" }, staff.treasurer)).code).toBe("dues_outstanding");
  });

  it("applies the member price only for a matching number, email and paid term", () => {
    const event = publishedEvent(staff); // 500 standard, 400 member
    const active = createMember(member(1), staff.treasurer);
    const unpaid = createMember(member(2, { name: "Unpaid", email: "unpaid@campus.example", duesPaid: false }), staff.treasurer);
    const lapsing = createMember(member(3, { expiresOn: addDays(today(), 2) }), staff.treasurer);

    const ok = registerForEvent(event.id, { name: "Member 1", email: active.email, studentId: null, memberNo: active.memberNo.toLowerCase() });
    expect(ok.priceCents).toBe(40000);
    expect(ok.memberNo).toBe(active.memberNo);

    // Right number, someone else's email.
    expect(appError(() => registerForEvent(event.id, { ...person(9), memberNo: active.memberNo })).fields?.memberNo).toBeTruthy();
    // Dues never paid.
    expect(appError(() => registerForEvent(event.id, { name: "Unpaid", email: "unpaid@campus.example", studentId: null, memberNo: unpaid.memberNo })).status).toBe(422);
    // A member's email without the number pays the standard price.
    expect(registerForEvent(event.id, { name: "Member 3", email: lapsing.email, studentId: null, memberNo: null }).priceCents).toBe(50000);

    // After the term ends the discount stops.
    const later = publishedEvent(staff, { title: "Later Event", startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), endsAt: new Date(Date.now() + 5.2 * 86_400_000).toISOString() });
    setClock(() => new Date(Date.now() + 3 * 86_400_000));
    expect(appError(() => registerForEvent(later.id, { name: "Member 3", email: lapsing.email, studentId: null, memberNo: lapsing.memberNo })).status).toBe(422);
    setClock(null);

    expect(getMember(active.id).tickets).toHaveLength(1);
  });
});

describe("merchandise", () => {
  const hoodie = () =>
    createProduct(
      productInputSchema.parse({
        name: "Hoodie",
        priceCents: 120000,
        memberPriceCents: 100000,
        variants: [{ size: "M", stock: 3 }, { size: "L", stock: 0 }],
      }),
      staff.treasurer,
    );
  const order = (productId: string, variantId: string, quantity: number, n = 1) =>
    placeOrder({ productId, variantId, quantity, ...person(n) });

  it("validates products and stock", () => {
    const base = { name: "Tee", priceCents: 45000, memberPriceCents: 38000, variants: [{ size: "M", stock: 5 }] };
    expect(productInputSchema.safeParse(base).success).toBe(true);
    expect(productInputSchema.safeParse({ ...base, variants: [] }).success).toBe(false);
    expect(productInputSchema.safeParse({ ...base, variants: [{ size: "M", stock: -1 }] }).success).toBe(false);
    expect(productInputSchema.safeParse({ ...base, variants: [{ size: "M", stock: 1 }, { size: "m", stock: 1 }] }).success).toBe(false);
    expect(productInputSchema.safeParse({ ...base, memberPriceCents: 50000 }).success).toBe(false);
    const p = hoodie();
    expect(appError(() => setStock(p.id, p.variants[0].id, 5, staff.organizer)).status).toBe(403);
    // Even a caller that skipped validation cannot push stock below zero.
    expect(() => setStock(p.id, p.variants[0].id, -1, staff.treasurer)).toThrow();
    expect(getProduct(p.id).variants[0].stock).toBe(3);
  });

  it("never sells more than is in stock", () => {
    const p = hoodie();
    const [m, l] = p.variants;
    expect(appError(() => order(p.id, l.id, 1)).code).toBe("out_of_stock");
    expect(order(p.id, m.id, 2).totalCents).toBe(240000);
    const tooMany = appError(() => order(p.id, m.id, 2, 2));
    expect(tooMany.code).toBe("out_of_stock");
    expect(tooMany.message).toContain("Only 1 left");
    order(p.id, m.id, 1, 3);
    expect(getProduct(p.id).variants[0].stock).toBe(0);
    expect(appError(() => order(p.id, m.id, 1, 4)).code).toBe("out_of_stock");
    expect(listOrders()).toHaveLength(2);
    expect(get<{ n: number }>("SELECT SUM(quantity) AS n FROM orders")!.n).toBe(3);
    expect(listPublicProducts()[0].variants.every((v) => !v.inStock)).toBe(true);
  });

  it("tracks payment, hand-over and cancellation through the ledger", () => {
    const p = hoodie();
    const placed = order(p.id, p.variants[0].id, 1);
    expect(placed.paymentStatus).toBe("pending");
    const [row] = listOrders();
    expect(getFinanceSummary().incomePendingCents).toBe(120000);

    expect(appError(() => actOnOrder(row.id, "fulfil", "cash", staff.treasurer)).code).toBe("payment_required");
    expect(appError(() => actOnOrder(row.id, "pay", "cash", staff.organizer)).status).toBe(403);
    expect(actOnOrder(row.id, "pay", "upi", staff.treasurer).order.paymentStatus).toBe("paid");
    expect(getFinanceSummary().incomeSettledCents).toBe(120000);
    expect(actOnOrder(row.id, "fulfil", "cash", staff.treasurer).order.status).toBe("fulfilled");
    expect(appError(() => actOnOrder(row.id, "cancel", "cash", staff.treasurer)).code).toBe("already_fulfilled");

    // Cancelling an unpaid order returns the units and removes the charge.
    order(p.id, p.variants[0].id, 2, 2);
    const second = listOrders().find((o) => o.quantity === 2)!;
    expect(getProduct(p.id).variants[0].stock).toBe(0);
    expect(actOnOrder(second.id, "cancel", "cash", staff.treasurer).refundDueCents).toBe(0);
    expect(getProduct(p.id).variants[0].stock).toBe(2);
    expect(getFinanceSummary().incomePendingCents).toBe(0);
    expect(getProduct(p.id).unitsSold).toBe(1);
  });

  it("gives members the member price", () => {
    const p = hoodie();
    const m = createMember(member(1), staff.treasurer);
    const placed = placeOrder({ productId: p.id, variantId: p.variants[0].id, quantity: 1, name: m.name, email: m.email, memberNo: m.memberNo });
    expect(placed.totalCents).toBe(100000);
    expect(placed.isMember).toBe(true);
    expect(appError(() => placeOrder({ productId: p.id, variantId: p.variants[0].id, quantity: 1, ...person(5), memberNo: m.memberNo })).status).toBe(422);
    expect(getProduct(p.id).variants[0].stock).toBe(2); // the rejected order took nothing
  });
});

describe("tasks and announcements", () => {
  it("flags overdue tasks until they are done", () => {
    const task = (title: string, dueOn: string | null, status = "todo") => {
      const created = createTask(taskInputSchema.parse({ title, dueOn }), staff.organizer);
      if (status === "done") {
        transitionTask(created.id, "start", staff.organizer);
        transitionTask(created.id, "done", staff.organizer);
      }
      return created;
    };
    const late = task("Book the hall", addDays(today(), -3));
    task("Print posters", addDays(today(), 2));
    task("Due today", today());
    task("No date", null);
    task("Finished late", addDays(today(), -10), "done");

    const overdue = listTasks().filter((t) => t.isOverdue);
    expect(overdue.map((t) => t.title)).toEqual(["Book the hall"]);
    expect(overdue[0].daysOverdue).toBe(3);

    transitionTask(late.id, "start", staff.organizer);
    expect(listTasks().filter((t) => t.isOverdue)).toHaveLength(1); // started, still late
    transitionTask(late.id, "done", staff.organizer);
    expect(listTasks().filter((t) => t.isOverdue)).toHaveLength(0);
    expect(taskInputSchema.safeParse({ title: "" }).success).toBe(false);
    expect(taskInputSchema.safeParse({ title: "Ok", dueOn: "tomorrow" }).success).toBe(false);
  });

  it("keeps member-only announcements off the public board", () => {
    createAnnouncement({ title: "Open to all", body: "Bake sale on Friday.", audience: "everyone" }, staff.organizer);
    createAnnouncement({ title: "Members only", body: "AGM in Room 204.", audience: "members" }, staff.admin);
    expect(listAnnouncements()).toHaveLength(2);
    expect(listPublicAnnouncements().map((a) => a.title)).toEqual(["Open to all"]);
    expect(appError(() => createAnnouncement({ title: "Nope", body: "No access", audience: "everyone" }, staff.treasurer)).status).toBe(403);
  });
});

describe("dashboard and demo data", () => {
  it("reports an empty club without errors", () => {
    const d = getDashboard();
    expect(d.members.total).toBe(0);
    expect(d.events.next).toBeNull();
    expect(d.tickets.attendanceRate).toBeNull();
    expect(d.finance.netCents).toBe(0);
    expect(d.alerts).toEqual([]);
  });

  it("seeds a consistent demo whose figures reconcile", () => {
    const summary = seedDemoData();
    expect(summary.users).toBe(3);

    const d = getDashboard();
    const events = listEvents();
    const members = listMembers();
    expect(d.members.total).toBe(members.length);
    expect(d.members.active).toBe(members.filter((m) => m.status === "active" || m.status === "expiring").length);
    expect(d.members.expiring).toBe(3);
    expect(d.members.lapsed).toBe(2);
    expect(d.members.unpaid).toBe(3);

    // Ticket counts on the dashboard equal the ticket rows.
    const rows = get<{ n: number; checked: number; pending: number }>(
      "SELECT COUNT(*) AS n, SUM(checked_in_at IS NOT NULL) AS checked, SUM(payment_status = 'pending') AS pending FROM tickets WHERE status = 'valid'",
    )!;
    expect(d.tickets.registered).toBe(rows.n);
    expect(d.tickets.checkedIn).toBe(rows.checked);
    expect(d.tickets.pending).toBe(rows.pending);
    expect(summary.tickets).toBe(rows.n);

    // No event is over capacity.
    for (const e of events) expect(e.stats.registered).toBeLessThanOrEqual(e.capacity);

    // Money: dashboard totals equal the ledger, and every ticket agrees with its charge.
    const ledger = listTransactions();
    const sum = (type: string, status: string) =>
      ledger.filter((t) => t.type === type && t.status === status).reduce((s, t) => s + t.amountCents, 0);
    expect(d.finance.incomeSettledCents).toBe(sum("income", "settled"));
    expect(d.finance.expenseSettledCents).toBe(sum("expense", "settled"));
    expect(d.finance.incomePendingCents).toBe(sum("income", "pending"));
    expect(d.finance.netCents).toBe(sum("income", "settled") - sum("expense", "settled"));
    const mismatched = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tickets t JOIN transactions x ON x.ticket_id = t.id AND x.source = 'ticket'
       WHERE x.voided_at IS NULL AND ((t.payment_status = 'paid') <> (x.status = 'settled') OR x.amount_cents <> t.price_cents)`,
    )!;
    expect(mismatched.n).toBe(0);
    const paidWithoutCharge = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tickets t WHERE t.price_cents > 0
       AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.ticket_id = t.id AND x.source = 'ticket')`,
    )!;
    expect(paidWithoutCharge.n).toBe(0);

    // Stock never negative; the demo deliberately sells out one size.
    expect(get<{ n: number }>("SELECT MIN(stock) AS n FROM product_variants")!.n).toBe(0);
    expect(d.alerts.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["overdue_tasks", "pending_reimbursements", "unpaid_tickets", "expiring_members", "low_stock"]),
    );
    expect(d.tasks.overdue).toBe(3);

    const gala = events.find((e) => e.title.startsWith("Winter Gala"))!;
    expect(getEvent(gala.id).profitTargetCents).toBe(2000000);
  });
});
