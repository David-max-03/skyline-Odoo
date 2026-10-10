import { beforeEach, describe, expect, it } from "vitest";
import { memberInputSchema, memberProfileSchema, passwordChangeSchema, type SessionUser } from "@/lib/contracts";
import { addDays } from "@/lib/dates";
import { changeMemberPassword, completeSetup, createSetupToken, getSessionUser, login } from "@/server/auth";
import { setClock, today } from "@/server/db";
import { createAnnouncement, listMemberAnnouncements, listPublicAnnouncements } from "@/server/services/announcements";
import { getEvent } from "@/server/services/events";
import { getFinanceTotals, listMemberPayments, listTransactions } from "@/server/services/finance";
import { createMember, getMember, updateOwnProfile } from "@/server/services/members";
import { cancelOwnTicket, checkIn, payTicket, registerForEvent, registerMember } from "@/server/services/tickets";
import { appError, freshDb, person, publishedEvent, type Staff } from "./helpers";

let staff: Staff;
beforeEach(() => {
  staff = freshDb();
});

const PASSWORD = "a-long-test-password";

function memberAccount(n: number, overrides: Record<string, unknown> = {}): SessionUser & { memberId: string } {
  const member = createMember(
    memberInputSchema.parse({ name: `Member ${n}`, email: `member${n}@campus.example`, duesPaid: true, ...overrides }),
    staff.treasurer,
  );
  completeSetup(createSetupToken(member.id, staff.admin.id).token, PASSWORD);
  return login(member.memberNo, PASSWORD).user as SessionUser & { memberId: string };
}

describe("a member registering for events", () => {
  it("registers as themselves at the member price, unpaid until staff record payment", () => {
    const me = memberAccount(1);
    const event = publishedEvent(staff); // 500 standard, 400 member
    const ticket = registerMember(event.id, me.memberId);

    expect(ticket).toMatchObject({ attendeeName: "Member 1", attendeeEmail: "member1@campus.example", priceCents: 40000, paymentStatus: "pending", memberId: me.memberId });
    expect(getMember(me.memberId).tickets.map((t) => t.code)).toEqual([ticket.code]);
    // Owed, not collected.
    expect(listTransactions({ category: "tickets" })[0]).toMatchObject({ status: "pending", amountCents: 40000 });

    expect(payTicket(ticket.code, "upi", staff.treasurer).paymentStatus).toBe("paid");
    expect(getMember(me.memberId).tickets[0].paymentStatus).toBe("paid");
  });

  it("gets a free ticket straight away for a free event", () => {
    const me = memberAccount(1);
    const event = publishedEvent(staff, { priceCents: 0, memberPriceCents: 0 });
    expect(registerMember(event.id, me.memberId)).toMatchObject({ priceCents: 0, paymentStatus: "free" });
    expect(listTransactions({ category: "tickets" })).toHaveLength(0);
  });

  it("pays the standard price when the membership is not active", () => {
    const lapsing = memberAccount(1, { expiresOn: addDays(today(), 1) });
    const unpaid = memberAccount(2, { duesPaid: false });
    const event = publishedEvent(staff, { startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), endsAt: new Date(Date.now() + 9.2 * 86_400_000).toISOString() });

    expect(registerMember(event.id, unpaid.memberId)).toMatchObject({ priceCents: 50000, memberId: null });
    setClock(() => new Date(Date.now() + 3 * 86_400_000));
    expect(registerMember(event.id, lapsing.memberId)).toMatchObject({ priceCents: 50000, memberId: null });
    setClock(null);
    // The ticket is still theirs: it is matched by their email.
    expect(getMember(unpaid.memberId).tickets).toHaveLength(1);
  });

  it("cannot register twice, for a draft, or past capacity", () => {
    const a = memberAccount(1);
    const b = memberAccount(2);
    const event = publishedEvent(staff, { capacity: 1 });
    registerMember(event.id, a.memberId);
    expect(appError(() => registerMember(event.id, a.memberId)).code).toBe("already_registered");
    expect(appError(() => registerMember(event.id, b.memberId)).code).toBe("sold_out");
    expect(appError(() => registerMember("evt_missing", b.memberId)).status).toBe(404);
    expect(getEvent(event.id).stats.registered).toBe(1);
  });

  it("keeps capacity exact when members and visitors register together", () => {
    const members = [1, 2, 3].map((n) => memberAccount(n));
    const event = publishedEvent(staff, { capacity: 4 });
    const results = [
      ...members.map((m) => () => registerMember(event.id, m.memberId)),
      ...[11, 12, 13].map((n) => () => registerForEvent(event.id, person(n))),
    ].map((attempt) => {
      try {
        attempt();
        return "ok";
      } catch (error) {
        return (error as { code?: string }).code;
      }
    });
    expect(results.filter((r) => r === "ok")).toHaveLength(4);
    expect(results.filter((r) => r === "sold_out")).toHaveLength(2);
    expect(getEvent(event.id).stats).toMatchObject({ registered: 4, remaining: 0 });
  });
});

describe("a member's own tickets", () => {
  it("can be cancelled while unpaid and unused, which frees the seat and the charge", () => {
    const me = memberAccount(1);
    const event = publishedEvent(staff, { capacity: 1 });
    const ticket = registerMember(event.id, me.memberId);
    expect(cancelOwnTicket(ticket.code, me.memberId).status).toBe("cancelled");
    expect(getFinanceTotals().incomePendingCents).toBe(0);
    expect(getEvent(event.id).stats.remaining).toBe(1);
    expect(appError(() => cancelOwnTicket(ticket.code, me.memberId)).code).toBe("ticket_cancelled");
    // They may register again afterwards.
    expect(registerMember(event.id, me.memberId).status).toBe("valid");
  });

  it("cannot be cancelled by the member once paid or used", () => {
    const me = memberAccount(1);
    const event = publishedEvent(staff);
    const paid = registerMember(event.id, me.memberId);
    payTicket(paid.code, "cash", staff.treasurer);
    expect(appError(() => cancelOwnTicket(paid.code, me.memberId)).code).toBe("paid_ticket");

    const free = publishedEvent(staff, { title: "Free night", priceCents: 0, memberPriceCents: 0 });
    const used = registerMember(free.id, me.memberId);
    expect(checkIn({ code: used.code, eventId: free.id, collectPayment: false, method: "cash" }, staff.organizer).outcome).toBe("checked_in");
    expect(appError(() => cancelOwnTicket(used.code, me.memberId)).code).toBe("already_checked_in");
    // And the door still refuses a second scan.
    expect(checkIn({ code: used.code, eventId: free.id, collectPayment: false, method: "cash" }, staff.organizer).outcome).toBe("already_checked_in");
  });

  it("belong to one member: nobody else can cancel them", () => {
    const a = memberAccount(1);
    const b = memberAccount(2);
    const event = publishedEvent(staff);
    const theirs = registerMember(event.id, a.memberId);
    const visitors = registerForEvent(event.id, person(9));

    expect(appError(() => cancelOwnTicket(theirs.code, b.memberId)).status).toBe(404);
    expect(appError(() => cancelOwnTicket(visitors.code, b.memberId)).status).toBe(404);
    expect(appError(() => cancelOwnTicket("SKY-22222-22222", b.memberId)).status).toBe(404);
    expect(getEvent(event.id).stats.registered).toBe(2);
    expect(getMember(b.memberId).tickets).toHaveLength(0);
  });
});

describe("a member's profile, password and records", () => {
  it("lets a member change only their phone number and student ID", () => {
    const me = memberAccount(1);
    const input = memberProfileSchema.parse({ phone: "98765 43210", studentId: "SKY2026", name: "Admin", email: "boss@skyline.club", memberNo: "SKY-M-9999", role: "admin" });
    expect(Object.keys(input).sort()).toEqual(["phone", "studentId"]);
    const updated = updateOwnProfile(me.memberId, input);
    expect(updated).toMatchObject({ phone: "98765 43210", studentId: "SKY2026", name: "Member 1", email: "member1@campus.example", memberNo: "SKY-M-0001" });
    expect(appError(() => updateOwnProfile("mem_missing", input)).status).toBe(404);
  });

  it("changes a password only with the current one, and signs other devices out", () => {
    const me = memberAccount(1);
    const here = login("SKY-M-0001", PASSWORD);
    const elsewhere = login("SKY-M-0001", PASSWORD);

    expect(passwordChangeSchema.safeParse({ currentPassword: PASSWORD, newPassword: "short" }).success).toBe(false);
    expect(appError(() => changeMemberPassword(me.memberId, "not-my-password", "another-long-password", here.token)).fields?.currentPassword).toBeTruthy();
    expect(appError(() => changeMemberPassword(me.memberId, PASSWORD, PASSWORD, here.token)).fields?.newPassword).toBeTruthy();
    expect(appError(() => changeMemberPassword(me.memberId, PASSWORD, "member1@campus.example", here.token)).fields?.newPassword).toBeTruthy();
    expect(getSessionUser(elsewhere.token)).not.toBeNull();

    changeMemberPassword(me.memberId, PASSWORD, "another-long-password", here.token);
    expect(getSessionUser(here.token)?.memberId).toBe(me.memberId);
    expect(getSessionUser(elsewhere.token)).toBeNull();
    expect(appError(() => login("SKY-M-0001", PASSWORD)).code).toBe("invalid_credentials");
    expect(login("SKY-M-0001", "another-long-password").user.role).toBe("member");
  });

  it("shows a member their own payment records and nobody else's", () => {
    const a = memberAccount(1);
    const b = memberAccount(2);
    const event = publishedEvent(staff);
    registerMember(event.id, a.memberId);
    registerForEvent(event.id, person(7));

    const mine = listMemberPayments(a.memberId);
    expect(mine.map((p) => [p.type, p.status, p.amountCents])).toEqual([
      ["income", "pending", 40000], // their ticket
      ["income", "settled", 50000], // their dues
    ]);
    expect(listMemberPayments(b.memberId)).toHaveLength(1);
    expect(listTransactions()).toHaveLength(4);
  });

  it("shows members the member-only announcements that the public board hides", () => {
    createAnnouncement({ title: "Open to all", body: "Bake sale on Friday.", audience: "everyone" }, staff.organizer);
    createAnnouncement({ title: "Members only", body: "AGM in Room 204.", audience: "members" }, staff.admin);
    expect(listPublicAnnouncements().map((a) => a.title)).toEqual(["Open to all"]);
    expect(listMemberAnnouncements().map((a) => [a.title, a.membersOnly]).sort()).toEqual([
      ["Members only", true],
      ["Open to all", false],
    ]);
  });
});
