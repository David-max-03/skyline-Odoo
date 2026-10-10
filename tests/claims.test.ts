import { beforeEach, describe, expect, it } from "vitest";
import { claimInputSchema, claimReviewSchema, memberInputSchema, taskInputSchema, transactionInputSchema, type SessionUser } from "@/lib/contracts";
import { addDays } from "@/lib/dates";
import { completeSetup, createSetupToken, login } from "@/server/auth";
import { all, today } from "@/server/db";
import { readEvidence } from "@/server/services/applications";
import { claimAccess, listClaims, reviewClaim, submitClaim } from "@/server/services/claims";
import { getFinanceTotals, listTransactions, settleTransaction, updateTransaction, voidTransaction } from "@/server/services/finance";
import { createMember } from "@/server/services/members";
import { createTask } from "@/server/services/tasks";
import { storedFileIds } from "@/server/storage";
import { appError, freshDb, type Staff } from "./helpers";

let staff: Staff;
beforeEach(async () => {
  staff = await freshDb();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const claim = (overrides: Record<string, unknown> = {}) =>
  claimInputSchema.parse({
    title: "Balloons and tape",
    amountCents: "45000", // form fields arrive as text
    spentOn: today(),
    category: "supplies",
    justification: "Decorations for the freshers' mixer stage.",
    ...overrides,
  });

/** A member with a password. `volunteer` gives them a task, which is what makes them eligible. */
async function memberAccount(n: number, volunteer = true): Promise<SessionUser> {
  const member = await createMember(
    memberInputSchema.parse({ name: `Member ${n}`, email: `member${n}@campus.example`, duesPaid: true }),
    staff.treasurer,
  );
  await completeSetup((await createSetupToken(member.id, staff.admin.id)).token, "a-long-test-password");
  if (volunteer) await createTask(taskInputSchema.parse({ title: "Decorate the hall", assigneeMemberId: member.id }), staff.organizer);
  return (await login(member.memberNo, "a-long-test-password")).user;
}

/** Expense rows only: creating a paid-up member in these tests adds a dues income row. */
const expenses = () => listTransactions({ type: "expense" });

const uploads = () => storedFileIds();

describe("filing a claim", () => {
  it("requires a photo, and the photo must really be an image", async () => {
    const me = await memberAccount(1);
    expect((await appError(() => submitClaim(claim(), null, me))).fields?.evidence).toBeTruthy();
    expect((await appError(() => submitClaim(claim(), Buffer.from("%PDF-1.7 receipt"), me))).fields?.evidence).toBeTruthy();
    expect((await appError(() => submitClaim(claim(), Buffer.from("<svg onload=alert(1)>"), me))).fields?.evidence).toBeTruthy();
    expect(await all("SELECT 1 FROM expense_claims")).toHaveLength(0);
    expect(await uploads()).toHaveLength(0);

    const filed = await submitClaim(claim(), PNG, me);
    expect(filed).toMatchObject({ status: "submitted", amountCents: 45000, claimantName: "Member 1", claimantKind: "member", isMine: true });
    expect(filed.code).toMatch(/^CLM-[2-9A-Z]{6}$/);
    expect(await uploads()).toEqual([filed.evidenceFileId]);
  });

  it("validates the amount, date and required fields", async () => {
    const base = { title: "Tape", amountCents: "100", spentOn: today(), category: "supplies", justification: "Needed for the stage." };
    expect(claimInputSchema.safeParse({ ...base, amountCents: "0" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, amountCents: "-5" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, amountCents: "12.5" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, amountCents: "lots" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, spentOn: "yesterday" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, category: "refund" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, justification: "" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, title: "" }).success).toBe(false);

    const me = await memberAccount(1);
    expect((await appError(() => submitClaim(claim({ spentOn: addDays(today(), 1) }), PNG, me))).fields?.spentOn).toBeTruthy();
    expect((await appError(() => submitClaim(claim({ eventId: "evt_missing" }), PNG, me))).fields?.eventId).toBeTruthy();
    expect(await uploads()).toHaveLength(0);
  });

  it("is open to committee accounts and to members who volunteer, and to nobody else", async () => {
    const volunteer = await memberAccount(1);
    const bystander = await memberAccount(2, false);
    expect(await claimAccess(volunteer)).toMatchObject({ canSubmit: true, canReview: false });
    expect(await claimAccess(bystander)).toMatchObject({ canSubmit: false, canReview: false });
    expect(await claimAccess(staff.organizer)).toMatchObject({ canSubmit: true, canReview: false });
    expect(await claimAccess(staff.treasurer)).toMatchObject({ canSubmit: true, canReview: true });

    expect((await appError(() => submitClaim(claim(), PNG, bystander))).status).toBe(403);
    expect((await appError(() => submitClaim(claim(), PNG, null))).status).toBe(401);
    expect(await submitClaim(claim(), PNG, staff.organizer)).toMatchObject({ claimantKind: "staff", claimantName: "Organizer" });
  });

  it("puts nothing in the ledger", async () => {
    await submitClaim(claim(), PNG, await memberAccount(1));
    expect(await expenses()).toHaveLength(0);
    expect((await getFinanceTotals()).expensePendingCents).toBe(0);
  });
});

describe("who sees which claims and receipts", () => {
  it("shows a claimant only their own claims and reviewers all of them", async () => {
    const a = await memberAccount(1);
    const b = await memberAccount(2);
    await submitClaim(claim({ title: "A's taxi" }), PNG, a);
    await submitClaim(claim({ title: "B's printing" }), PNG, b);
    await submitClaim(claim({ title: "Organizer's snacks" }), PNG, staff.organizer);

    expect((await listClaims(a)).claims.map((c) => c.title)).toEqual(["A's taxi"]);
    expect((await listClaims(b)).claims.map((c) => c.title)).toEqual(["B's printing"]);
    expect((await listClaims(staff.organizer)).claims.map((c) => c.title)).toEqual(["Organizer's snacks"]);
    expect((await listClaims(staff.treasurer)).claims).toHaveLength(3);
    expect((await listClaims(staff.admin)).claims).toHaveLength(3);
    expect((await appError(() => listClaims(null))).status).toBe(401);
  });

  it("opens a receipt photo for the claimant and the reviewers only", async () => {
    const a = await memberAccount(1);
    const b = await memberAccount(2);
    const mine = await submitClaim(claim(), PNG, a);
    const organizers = await submitClaim(claim(), PNG, staff.organizer);

    expect((await readEvidence(mine.evidenceFileId, a)).bytes.equals(PNG)).toBe(true);
    expect((await readEvidence(mine.evidenceFileId, staff.treasurer)).mime).toBe("image/png");
    expect((await readEvidence(mine.evidenceFileId, staff.admin)).mime).toBe("image/png");
    expect((await appError(() => readEvidence(mine.evidenceFileId, b))).status).toBe(403);
    expect((await appError(() => readEvidence(mine.evidenceFileId, staff.organizer))).status).toBe(403);
    expect((await appError(() => readEvidence(mine.evidenceFileId, null))).status).toBe(401);

    expect((await readEvidence(organizers.evidenceFileId, staff.organizer)).mime).toBe("image/png");
    expect((await appError(() => readEvidence(organizers.evidenceFileId, a))).status).toBe(403);
  });
});

describe("reviewing a claim", () => {
  it("is for the treasurer and president, and never for the claimant", async () => {
    const me = await memberAccount(1);
    const mine = await submitClaim(claim(), PNG, me);
    const approve = claimReviewSchema.parse({ action: "approve" });

    expect((await appError(() => reviewClaim(mine.id, approve, me))).status).toBe(403);
    expect((await appError(() => reviewClaim(mine.id, approve, staff.organizer))).status).toBe(403);
    expect((await appError(() => reviewClaim(mine.id, approve, null))).status).toBe(401);
    expect((await appError(() => reviewClaim("clm_missing", approve, staff.treasurer))).status).toBe(404);

    // A treasurer who files a claim cannot approve or pay it; the president can.
    const treasurers = await submitClaim(claim({ title: "Receipt books" }), PNG, staff.treasurer);
    expect((await appError(() => reviewClaim(treasurers.id, approve, staff.treasurer))).status).toBe(403);
    expect((await reviewClaim(treasurers.id, approve, staff.admin)).status).toBe("approved");
    expect((await appError(() => reviewClaim(treasurers.id, claimReviewSchema.parse({ action: "pay", method: "upi" }), staff.treasurer))).status).toBe(403);
    expect(await expenses()).toHaveLength(1);
  });

  it("writes exactly one ledger entry on approval and settles that same entry on payment", async () => {
    const me = await memberAccount(1);
    const filed = await submitClaim(claim(), PNG, me);
    expect((await reviewClaim(filed.id, { action: "start_review" }, staff.treasurer)).status).toBe("under_review");
    expect(await expenses()).toHaveLength(0);

    const approved = await reviewClaim(filed.id, claimReviewSchema.parse({ action: "approve", note: "Matches the receipt" }), staff.treasurer);
    expect(approved).toMatchObject({ status: "approved", reviewedByName: "Treasurer", reviewNote: "Matches the receipt" });
    const [entry] = await expenses();
    expect(entry).toMatchObject({ type: "expense", category: "supplies", status: "pending", amountCents: 45000, claimId: filed.id, counterparty: "Member 1" });
    expect(approved.transactionId).toBe(entry.id);
    expect(await getFinanceTotals()).toMatchObject({ expensePendingCents: 45000, expenseSettledCents: 0 });

    // Approving, rejecting or restarting review again changes nothing.
    for (const again of [{ action: "approve", note: null }, { action: "reject", reason: "Changed my mind" }, { action: "start_review" }] as const) {
      expect((await appError(() => reviewClaim(filed.id, again, staff.admin))).code).toBe("invalid_claim_status");
    }
    expect(await expenses()).toHaveLength(1);

    const paid = await reviewClaim(filed.id, { action: "pay", method: "upi" }, staff.treasurer);
    expect(paid.status).toBe("paid");
    expect(await expenses()).toHaveLength(1);
    expect((await expenses())[0]).toMatchObject({ status: "settled", method: "upi" });
    expect(await getFinanceTotals()).toMatchObject({ expensePendingCents: 0, expenseSettledCents: 45000 });
    expect((await appError(() => reviewClaim(filed.id, { action: "pay", method: "upi" }, staff.treasurer))).code).toBe("not_approved");
    expect((await getFinanceTotals()).expenseSettledCents).toBe(45000);
  });

  it("marks the claim paid when the entry is settled from the finance screen instead", async () => {
    const filed = await submitClaim(claim(), PNG, await memberAccount(1));
    const approved = await reviewClaim(filed.id, { action: "approve", note: null }, staff.treasurer);
    await settleTransaction(approved.transactionId!, "bank", staff.treasurer);
    expect((await listClaims(staff.treasurer)).claims[0].status).toBe("paid");
  });

  it("does not let the claim's ledger entry be edited or voided behind its back", async () => {
    const filed = await submitClaim(claim(), PNG, await memberAccount(1));
    const { transactionId } = await reviewClaim(filed.id, { action: "approve", note: null }, staff.treasurer);
    const edit = transactionInputSchema.parse({ type: "expense", category: "supplies", amountCents: 1, status: "pending", occurredOn: today(), description: "Shrunk" });
    expect((await appError(() => updateTransaction(transactionId!, edit, staff.treasurer))).code).toBe("linked_entry");
    expect((await appError(() => voidTransaction(transactionId!, "Oops, wrong", staff.treasurer))).code).toBe("linked_entry");
    expect((await expenses())[0].amountCents).toBe(45000);
  });

  it("shows the reason for a rejection to the claimant and keeps it out of the books", async () => {
    const me = await memberAccount(1);
    const filed = await submitClaim(claim(), PNG, me);
    expect(claimReviewSchema.safeParse({ action: "reject" }).success).toBe(false);
    await reviewClaim(filed.id, { action: "reject", reason: "The receipt is unreadable" }, staff.admin);

    expect((await listClaims(me)).claims[0]).toMatchObject({ status: "rejected", reviewNote: "The receipt is unreadable", transactionId: null });
    expect(await expenses()).toHaveLength(0);
    expect((await appError(() => reviewClaim(filed.id, { action: "approve", note: null }, staff.admin))).code).toBe("invalid_claim_status");
    expect((await appError(() => reviewClaim(filed.id, { action: "pay", method: "cash" }, staff.admin))).code).toBe("not_approved");
  });
});
