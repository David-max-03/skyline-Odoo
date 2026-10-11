import {
  CAN,
  SETTINGS,
  type Member,
  type MemberDetail,
  type MemberInput,
  type MemberStatus,
  type MembershipPeriod,
  type PaymentMethod,
  type RenewInput,
  type SessionUser,
  type SetupLink,
} from "@/lib/contracts";
import { addDays, daysBetween } from "@/lib/dates";
import { createSetupToken } from "../auth";
import { all, get, newId, nowIso, run, today, tx } from "../db";
import { conflict, invalid, notFound, requireRole } from "../errors";
import { recordTransaction, settlePendingFor } from "./finance";

/**
 * Memberships. A member has one or more terms (`membership_periods`). A term
 * counts only once its dues are collected. Status is always derived from the
 * terms, never stored, so it cannot go stale.
 */

interface MemberRow {
  id: string;
  member_no: string;
  name: string;
  email: string;
  student_id: string | null;
  phone: string | null;
  joined_on: string;
  created_at: string;
  paid_until: string | null;
  dues_owed: number;
  has_account: number;
}

const SELECT = `
  SELECT m.*,
    CASE WHEN EXISTS (SELECT 1 FROM member_accounts a WHERE a.member_id = m.id) THEN 1 ELSE 0 END AS has_account,
    (SELECT MAX(p.ends_on) FROM membership_periods p
      WHERE p.member_id = m.id AND p.paid_at IS NOT NULL) AS paid_until,
    (SELECT COALESCE(SUM(p.amount_cents), 0) FROM membership_periods p
      WHERE p.member_id = m.id AND p.paid_at IS NULL) AS dues_owed
  FROM members m`;

export function memberStatus(paidUntil: string | null, on: string): MemberStatus {
  if (!paidUntil) return "unpaid";
  const days = daysBetween(on, paidUntil);
  if (days < 0) return "lapsed";
  return days <= SETTINGS.renewalReminderDays ? "expiring" : "active";
}

function toMember(r: MemberRow, on: string = today()): Member {
  return {
    id: r.id,
    memberNo: r.member_no,
    name: r.name,
    email: r.email,
    studentId: r.student_id,
    phone: r.phone,
    joinedOn: r.joined_on,
    paidUntilOn: r.paid_until,
    duesOwedCents: r.dues_owed,
    status: memberStatus(r.paid_until, on),
    daysToExpiry: r.paid_until ? daysBetween(on, r.paid_until) : null,
    hasAccount: r.has_account === 1,
    createdAt: r.created_at,
  };
}

const yearEnd = (ymd: string) => `${ymd.slice(0, 4)}-12-31`;

export async function listMembers(): Promise<Member[]> {
  const on = today();
  return (await all<MemberRow>(`${SELECT} ORDER BY lower(m.name), m.id`)).map((r) => toMember(r, on));
}

async function getMemberRow(id: string): Promise<MemberRow> {
  const row = await get<MemberRow>(`${SELECT} WHERE m.id = ?`, id);
  if (!row) throw notFound("Member");
  return row;
}

export async function getMember(id: string): Promise<MemberDetail> {
  const member = toMember(await getMemberRow(id));
  const periods = (await all<{
    id: string;
    kind: "new" | "renewal";
    starts_on: string;
    ends_on: string;
    amount_cents: number;
    paid_at: string | null;
    created_at: string;
  }>("SELECT * FROM membership_periods WHERE member_id = ? ORDER BY starts_on DESC", id)).map(
    (p): MembershipPeriod => ({
      id: p.id,
      kind: p.kind,
      startsOn: p.starts_on,
      endsOn: p.ends_on,
      amountCents: p.amount_cents,
      paidAt: p.paid_at,
      createdAt: p.created_at,
    }),
  );
  const tickets = (await all<{
    code: string;
    event_id: string;
    title: string;
    starts_at: string;
    price_cents: number;
    payment_status: MemberDetail["tickets"][number]["paymentStatus"];
    status: MemberDetail["tickets"][number]["status"];
    checked_in_at: string | null;
  }>(
    `SELECT t.code, t.event_id, e.title, e.starts_at, t.price_cents, t.payment_status, t.status, t.checked_in_at
     FROM tickets t JOIN events e ON e.id = t.event_id
     WHERE t.member_id = ? OR t.attendee_email = ?
     ORDER BY e.starts_at DESC`,
    id,
    member.email,
  )).map((t) => ({
    code: t.code,
    eventId: t.event_id,
    eventTitle: t.title,
    startsAt: t.starts_at,
    priceCents: t.price_cents,
    paymentStatus: t.payment_status,
    status: t.status,
    checkedInAt: t.checked_in_at,
  }));
  const orders = (await all<{
    code: string;
    name: string;
    size: string;
    quantity: number;
    total_cents: number;
    payment_status: "pending" | "paid";
    status: MemberDetail["orders"][number]["status"];
    created_at: string;
  }>(
    `SELECT o.code, p.name, v.size, o.quantity, o.total_cents, o.payment_status, o.status, o.created_at
     FROM orders o JOIN products p ON p.id = o.product_id JOIN product_variants v ON v.id = o.variant_id
       LEFT JOIN checkouts c ON c.id = o.checkout_id
     -- Theirs by record (their account, or a proven membership), never by a typed email. See merch.ts.
     WHERE o.member_id = ? OR c.member_id = ?
     ORDER BY o.created_at DESC`,
    id,
    id,
  )).map((o) => ({
    code: o.code,
    productName: o.name,
    size: o.size,
    quantity: o.quantity,
    totalCents: o.total_cents,
    paymentStatus: o.payment_status,
    status: o.status,
    createdAt: o.created_at,
  }));
  return { ...member, periods, tickets, orders };
}

async function nextMemberNo(): Promise<string> {
  const row = await get<{ n: number | null }>(
    "SELECT MAX(CAST(substr(member_no, 7) AS INTEGER)) AS n FROM members",
  );
  return `SKY-M-${String((row?.n ?? 0) + 1).padStart(4, "0")}`;
}

interface NewTerm {
  memberId: string;
  memberName: string;
  kind: "new" | "renewal";
  startsOn: string;
  endsOn: string;
  paid: boolean;
  method: PaymentMethod;
  createdBy: string | null;
  /** Appended to the ledger description, e.g. the payment reference that was verified. */
  note?: string;
  /** What was actually paid, when that is known. Defaults to the current fee. */
  amountCents?: number;
}

/** Adds a term and its dues entry in the ledger. Call inside a transaction. */
async function addTerm(t: NewTerm): Promise<void> {
  const periodId = newId("per");
  const ts = nowIso();
  const amountCents = t.amountCents ?? SETTINGS.membershipFeeCents;
  await run(
    `INSERT INTO membership_periods (id, member_id, kind, starts_on, ends_on, amount_cents, paid_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    periodId,
    t.memberId,
    t.kind,
    t.startsOn,
    t.endsOn,
    amountCents,
    t.paid ? ts : null,
    ts,
  );
  await recordTransaction({
    type: "income",
    category: "dues",
    amountCents,
    status: t.paid ? "settled" : "pending",
    description:
      `${t.kind === "new" ? "Membership dues" : "Membership renewal"} — ${t.memberName} (to ${t.endsOn})` +
      (t.note ? ` · ${t.note}` : ""),
    counterparty: t.memberName,
    method: t.paid ? t.method : null,
    source: "dues",
    memberId: t.memberId,
    periodId,
    createdBy: t.createdBy,
  });
}

async function insertMember(
  input: { name: string; email: string; studentId: string | null; phone: string | null },
  term: {
    paid: boolean;
    method: PaymentMethod;
    endsOn: string | null;
    createdBy: string | null;
    note?: string;
    amountCents?: number;
  },
): Promise<string> {
  const on = today();
  if (await get("SELECT 1 FROM members WHERE email = ?", input.email)) {
    throw conflict("email_taken", "This email is already on the member list.");
  }
  const endsOn = term.endsOn ?? yearEnd(on);
  if (endsOn < on) {
    throw invalid("The expiry date is in the past.", { expiresOn: "Choose today or a later date" });
  }
  const id = newId("mem");
  await run(
    `INSERT INTO members (id, member_no, name, email, student_id, phone, joined_on, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    await nextMemberNo(),
    input.name,
    input.email,
    input.studentId,
    input.phone,
    on,
    nowIso(),
  );
  await addTerm({
    memberId: id,
    memberName: input.name,
    kind: "new",
    startsOn: on,
    endsOn,
    paid: term.paid,
    method: term.method,
    createdBy: term.createdBy,
    note: term.note,
    amountCents: term.amountCents,
  });
  return id;
}

/** Staff adds a member, optionally recording dues as collected. */
export async function createMember(input: MemberInput, actor: SessionUser | null): Promise<Member> {
  const user = requireRole(actor, ...CAN.addMembers);
  return tx(async () => {
    const id = await insertMember(input, {
      paid: input.duesPaid,
      method: input.method,
      endsOn: input.expiresOn,
      createdBy: user.id,
    });
    return toMember(await getMemberRow(id));
  });
}

/**
 * Creates a paid-up member from an application whose payment has been
 * verified, by a reviewer or by the payment provider. This is where the member
 * ID is generated. It carries no role check: `reviewApplication` authorises
 * and calls it inside its transaction, and the online flow calls it only after
 * verifying the payment with Razorpay, with no staff account (`createdBy` null).
 */
export async function admitMember(
  input: { name: string; email: string; studentId: string | null; phone: string | null },
  payment: { method: PaymentMethod; reference: string; createdBy: string | null; amountCents?: number; note?: string },
): Promise<Member> {
  const id = await insertMember(input, {
    paid: true,
    method: payment.method,
    endsOn: null,
    createdBy: payment.createdBy,
    note: payment.note ?? `ref ${payment.reference}`,
    amountCents: payment.amountCents,
  });
  return toMember(await getMemberRow(id));
}

/** Builds a one-time password-setup link. Callers must have authorised first. */
export async function newSetupLink(memberId: string, createdBy: string | null): Promise<SetupLink> {
  const member = await getMemberRow(memberId);
  const { token, expiresAt } = await createSetupToken(memberId, createdBy);
  return {
    path: `/activate/${token}`,
    expiresAt,
    memberNo: member.member_no,
    name: member.name,
    email: member.email,
  };
}

/**
 * Staff issue a new setup link, for a member who never set a password or has
 * forgotten it. Any earlier unused link for the member stops working.
 */
export async function issueSetupLink(memberId: string, actor: SessionUser | null): Promise<SetupLink> {
  const user = requireRole(actor, "admin", "treasurer");
  return newSetupLink(memberId, user.id);
}

export async function updateMember(
  id: string,
  input: { name: string; email: string; studentId: string | null; phone: string | null },
  actor: SessionUser | null,
): Promise<Member> {
  requireRole(actor, "admin", "treasurer");
  return tx(async () => {
    await getMemberRow(id);
    if (await get("SELECT 1 FROM members WHERE email = ? AND id <> ?", input.email, id)) {
      throw conflict("email_taken", "Another member already uses this email.");
    }
    await run(
      "UPDATE members SET name = ?, email = ?, student_id = ?, phone = ? WHERE id = ?",
      input.name,
      input.email,
      input.studentId,
      input.phone,
      id,
    );
    return toMember(await getMemberRow(id));
  });
}

/**
 * A member edits their own contact details. Only the phone number and student
 * ID can change this way; the id always comes from the session.
 */
export async function updateOwnProfile(
  memberId: string,
  input: { phone: string | null; studentId: string | null },
): Promise<MemberDetail> {
  const changed = await run("UPDATE members SET phone = ?, student_id = ? WHERE id = ?", input.phone, input.studentId, memberId);
  if (changed.changes !== 1) throw notFound("Member");
  return getMember(memberId);
}

/** Collects every unpaid term for a member. */
export async function collectDues(id: string, method: PaymentMethod, actor: SessionUser | null): Promise<Member> {
  requireRole(actor, "admin", "treasurer");
  return tx(async () => {
    await getMemberRow(id);
    const unpaid = await all<{ id: string }>(
      "SELECT id FROM membership_periods WHERE member_id = ? AND paid_at IS NULL",
      id,
    );
    if (unpaid.length === 0) throw conflict("nothing_owed", "This member has no unpaid dues.");
    for (const period of unpaid) {
      if (!await settlePendingFor({ periodId: period.id }, method)) {
        // No ledger row to settle (should not happen); keep the term consistent anyway.
        await run("UPDATE membership_periods SET paid_at = ? WHERE id = ?", nowIso(), period.id);
      }
    }
    return toMember(await getMemberRow(id));
  });
}

/**
 * Starts the next term. It begins the day after the current paid term ends,
 * or today if the membership has lapsed, and runs to 31 December of that year.
 */
export async function renewMember(id: string, input: RenewInput, actor: SessionUser | null): Promise<Member> {
  const user = requireRole(actor, "admin", "treasurer");
  return tx(async () => {
    const row = await getMemberRow(id);
    if (row.dues_owed > 0) {
      throw conflict("dues_outstanding", "Collect this member's unpaid dues before adding another term.");
    }
    const on = today();
    const startsOn = row.paid_until && row.paid_until >= on ? addDays(row.paid_until, 1) : on;
    await addTerm({
      memberId: id,
      memberName: row.name,
      kind: "renewal",
      startsOn,
      endsOn: yearEnd(startsOn),
      paid: input.duesPaid,
      method: input.method,
      createdBy: user.id,
    });
    return toMember(await getMemberRow(id));
  });
}

/**
 * Member pricing check. Both the email and the member number must match, and
 * a paid term must cover today, so nobody can claim a discount (or probe the
 * member list) with an email address alone.
 */
export async function findActiveMember(email: string, memberNo: string): Promise<{ id: string; memberNo: string } | null> {
  const row = await get<MemberRow>(
    `${SELECT} WHERE m.email = ? AND m.member_no = ?`,
    email.trim().toLowerCase(),
    memberNo.trim().toUpperCase(),
  );
  if (!row || !row.paid_until || row.paid_until < today()) return null;
  return { id: row.id, memberNo: row.member_no };
}

export async function memberCounts(): Promise<Record<MemberStatus, number> & { total: number }> {
  const counts = { total: 0, active: 0, expiring: 0, lapsed: 0, unpaid: 0 };
  for (const m of await listMembers()) {
    counts.total += 1;
    counts[m.status] += 1;
  }
  return counts;
}
