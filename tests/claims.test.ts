import fs from "node:fs";
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
import { uploadDir } from "@/server/storage";
import { appError, freshDb, type Staff } from "./helpers";

let staff: Staff;
beforeEach(() => {
  staff = freshDb();
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
function memberAccount(n: number, volunteer = true): SessionUser {
  const member = createMember(
    memberInputSchema.parse({ name: `Member ${n}`, email: `member${n}@campus.example`, duesPaid: true }),
    staff.treasurer,
  );
  completeSetup(createSetupToken(member.id, staff.admin.id).token, "a-long-test-password");
  if (volunteer) createTask(taskInputSchema.parse({ title: "Decorate the hall", assigneeMemberId: member.id }), staff.organizer);
  return login(member.memberNo, "a-long-test-password").user;
}

/** Expense rows only: creating a paid-up member in these tests adds a dues income row. */
const expenses = () => listTransactions({ type: "expense" });

const uploads = () => (fs.existsSync(uploadDir()) ? fs.readdirSync(uploadDir()) : []);

describe("filing a claim", () => {
  it("requires a photo, and the photo must really be an image", () => {
    const me = memberAccount(1);
    expect(appError(() => submitClaim(claim(), null, me)).fields?.evidence).toBeTruthy();
    expect(appError(() => submitClaim(claim(), Buffer.from("%PDF-1.7 receipt"), me)).fields?.evidence).toBeTruthy();
    expect(appError(() => submitClaim(claim(), Buffer.from("<svg onload=alert(1)>"), me)).fields?.evidence).toBeTruthy();
    expect(all("SELECT 1 FROM expense_claims")).toHaveLength(0);
    expect(uploads()).toHaveLength(0);

    const filed = submitClaim(claim(), PNG, me);
    expect(filed).toMatchObject({ status: "submitted", amountCents: 45000, claimantName: "Member 1", claimantKind: "member", isMine: true });
    expect(filed.code).toMatch(/^CLM-[2-9A-Z]{6}$/);
    expect(uploads()).toEqual([filed.evidenceFileId]);
  });

  it("validates the amount, date and required fields", () => {
    const base = { title: "Tape", amountCents: "100", spentOn: today(), category: "supplies", justification: "Needed for the stage." };
    expect(claimInputSchema.safeParse({ ...base, amountCents: "0" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, amountCents: "-5" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, amountCents: "12.5" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, amountCents: "lots" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, spentOn: "yesterday" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, category: "refund" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, justification: "" }).success).toBe(false);
    expect(claimInputSchema.safeParse({ ...base, title: "" }).success).toBe(false);

    const me = memberAccount(1);
    expect(appError(() => submitClaim(claim({ spentOn: addDays(today(), 1) }), PNG, me)).fields?.spentOn).toBeTruthy();
    expect(appError(() => submitClaim(claim({ eventId: "evt_missing" }), PNG, me)).fields?.eventId).toBeTruthy();
    expect(uploads()).toHaveLength(0);
  });

  it("is open to committee accounts and to members who volunteer, and to nobody else", () => {
    const volunteer = memberAccount(1);
    const bystander = memberAccount(2, false);
    expect(claimAccess(volunteer)).toMatchObject({ canSubmit: true, canReview: false });
    expect(claimAccess(bystander)).toMatchObject({ canSubmit: false, canReview: false });
    expect(claimAccess(staff.organizer)).toMatchObject({ canSubmit: true, canReview: false });
    expect(claimAccess(staff.treasurer)).toMatchObject({ canSubmit: true, canReview: true });

    expect(appError(() => submitClaim(claim(), PNG, bystander)).status).toBe(403);
    expect(appError(() => submitClaim(claim(), PNG, null)).status).toBe(401);
    expect(submitClaim(claim(), PNG, staff.organizer)).toMatchObject({ claimantKind: "staff", claimantName: "Organizer" });
  });

  it("puts nothing in the ledger", () => {
    submitClaim(claim(), PNG, memberAccount(1));
    expect(expenses()).toHaveLength(0);
    expect(getFinanceTotals().expensePendingCents).toBe(0);
  });
});

describe("who sees which claims and receipts", () => {
  it("shows a claimant only their own claims and reviewers all of them", () => {
    const a = memberAccount(1);
    const b = memberAccount(2);
    submitClaim(claim({ title: "A's taxi" }), PNG, a);
    submitClaim(claim({ title: "B's printing" }), PNG, b);
    submitClaim(claim({ title: "Organizer's snacks" }), PNG, staff.organizer);

    expect(listClaims(a).claims.map((c) => c.title)).toEqual(["A's taxi"]);
    expect(listClaims(b).claims.map((c) => c.title)).toEqual(["B's printing"]);
    expect(listClaims(staff.organizer).claims.map((c) => c.title)).toEqual(["Organizer's snacks"]);
    expect(listClaims(staff.treasurer).claims).toHaveLength(3);
    expect(listClaims(staff.admin).claims).toHaveLength(3);
    expect(appError(() => listClaims(null)).status).toBe(401);
  });

  it("opens a receipt photo for the claimant and the reviewers only", () => {
    const a = memberAccount(1);
    const b = memberAccount(2);
    const mine = submitClaim(claim(), PNG, a);
    const organizers = submitClaim(claim(), PNG, staff.organizer);

    expect(readEvidence(mine.evidenceFileId, a).bytes.equals(PNG)).toBe(true);
    expect(readEvidence(mine.evidenceFileId, staff.treasurer).mime).toBe("image/png");
    expect(readEvidence(mine.evidenceFileId, staff.admin).mime).toBe("image/png");
    expect(appError(() => readEvidence(mine.evidenceFileId, b)).status).toBe(403);
    expect(appError(() => readEvidence(mine.evidenceFileId, staff.organizer)).status).toBe(403);
    expect(appError(() => readEvidence(mine.evidenceFileId, null)).status).toBe(401);

    expect(readEvidence(organizers.evidenceFileId, staff.organizer).mime).toBe("image/png");
    expect(appError(() => readEvidence(organizers.evidenceFileId, a)).status).toBe(403);
  });
});

describe("reviewing a claim", () => {
  it("is for the treasurer and president, and never for the claimant", () => {
    const me = memberAccount(1);
    const mine = submitClaim(claim(), PNG, me);
    const approve = claimReviewSchema.parse({ action: "approve" });

    expect(appError(() => reviewClaim(mine.id, approve, me)).status).toBe(403);
    expect(appError(() => reviewClaim(mine.id, approve, staff.organizer)).status).toBe(403);
    expect(appError(() => reviewClaim(mine.id, approve, null)).status).toBe(401);
    expect(appError(() => reviewClaim("clm_missing", approve, staff.treasurer)).status).toBe(404);

    // A treasurer who files a claim cannot approve or pay it; the president can.
    const treasurers = submitClaim(claim({ title: "Receipt books" }), PNG, staff.treasurer);
    expect(appError(() => reviewClaim(treasurers.id, approve, staff.treasurer)).status).toBe(403);
    expect(reviewClaim(treasurers.id, approve, staff.admin).status).toBe("approved");
    expect(appError(() => reviewClaim(treasurers.id, claimReviewSchema.parse({ action: "pay", method: "upi" }), staff.treasurer)).status).toBe(403);
    expect(expenses()).toHaveLength(1);
  });

  it("writes exactly one ledger entry on approval and settles that same entry on payment", () => {
    const me = memberAccount(1);
    const filed = submitClaim(claim(), PNG, me);
    expect(reviewClaim(filed.id, { action: "start_review" }, staff.treasurer).status).toBe("under_review");
    expect(expenses()).toHaveLength(0);

    const approved = reviewClaim(filed.id, claimReviewSchema.parse({ action: "approve", note: "Matches the receipt" }), staff.treasurer);
    expect(approved).toMatchObject({ status: "approved", reviewedByName: "Treasurer", reviewNote: "Matches the receipt" });
    const [entry] = expenses();
    expect(entry).toMatchObject({ type: "expense", category: "supplies", status: "pending", amountCents: 45000, claimId: filed.id, counterparty: "Member 1" });
    expect(approved.transactionId).toBe(entry.id);
    expect(getFinanceTotals()).toMatchObject({ expensePendingCents: 45000, expenseSettledCents: 0 });

    // Approving, rejecting or restarting review again changes nothing.
    for (const again of [{ action: "approve", note: null }, { action: "reject", reason: "Changed my mind" }, { action: "start_review" }] as const) {
      expect(appError(() => reviewClaim(filed.id, again, staff.admin)).code).toBe("invalid_claim_status");
    }
    expect(expenses()).toHaveLength(1);

    const paid = reviewClaim(filed.id, { action: "pay", method: "upi" }, staff.treasurer);
    expect(paid.status).toBe("paid");
    expect(expenses()).toHaveLength(1);
    expect(expenses()[0]).toMatchObject({ status: "settled", method: "upi" });
    expect(getFinanceTotals()).toMatchObject({ expensePendingCents: 0, expenseSettledCents: 45000 });
    expect(appError(() => reviewClaim(filed.id, { action: "pay", method: "upi" }, staff.treasurer)).code).toBe("not_approved");
    expect(getFinanceTotals().expenseSettledCents).toBe(45000);
  });

  it("marks the claim paid when the entry is settled from the finance screen instead", () => {
    const filed = submitClaim(claim(), PNG, memberAccount(1));
    const approved = reviewClaim(filed.id, { action: "approve", note: null }, staff.treasurer);
    settleTransaction(approved.transactionId!, "bank", staff.treasurer);
    expect(listClaims(staff.treasurer).claims[0].status).toBe("paid");
  });

  it("does not let the claim's ledger entry be edited or voided behind its back", () => {
    const filed = submitClaim(claim(), PNG, memberAccount(1));
    const { transactionId } = reviewClaim(filed.id, { action: "approve", note: null }, staff.treasurer);
    const edit = transactionInputSchema.parse({ type: "expense", category: "supplies", amountCents: 1, status: "pending", occurredOn: today(), description: "Shrunk" });
    expect(appError(() => updateTransaction(transactionId!, edit, staff.treasurer)).code).toBe("linked_entry");
    expect(appError(() => voidTransaction(transactionId!, "Oops, wrong", staff.treasurer)).code).toBe("linked_entry");
    expect(expenses()[0].amountCents).toBe(45000);
  });

  it("shows the reason for a rejection to the claimant and keeps it out of the books", () => {
    const me = memberAccount(1);
    const filed = submitClaim(claim(), PNG, me);
    expect(claimReviewSchema.safeParse({ action: "reject" }).success).toBe(false);
    reviewClaim(filed.id, { action: "reject", reason: "The receipt is unreadable" }, staff.admin);

    expect(listClaims(me).claims[0]).toMatchObject({ status: "rejected", reviewNote: "The receipt is unreadable", transactionId: null });
    expect(expenses()).toHaveLength(0);
    expect(appError(() => reviewClaim(filed.id, { action: "approve", note: null }, staff.admin)).code).toBe("invalid_claim_status");
    expect(appError(() => reviewClaim(filed.id, { action: "pay", method: "cash" }, staff.admin)).code).toBe("not_approved");
  });
});
