import type {
  ClaimAccess,
  ClaimCategory,
  ClaimInput,
  ClaimList,
  ClaimReviewInput,
  ClaimStatus,
  ExpenseClaim,
  SessionUser,
} from "@/lib/contracts";
import { all, get, newId, nowIso, randomCode, run, today, tx } from "../db";
import { conflict, forbidden, invalid, notFound, requireRole, unauthorized } from "../errors";
import { discardFile, storeImage } from "../storage";
import { recordTransaction, settleTransaction } from "./finance";

/**
 * Expense claims.
 *
 * Someone who paid for something out of pocket files a claim with a photo of
 * the receipt. A claim is a request and is not in the ledger. When a reviewer
 * approves it, exactly one pending expense row is written to the existing
 * ledger and linked to the claim. Paying that row, from here or from the
 * finance screen, marks the claim paid. There is no second set of books.
 *
 * Reviewers are the treasurer and the president. Nobody reviews their own claim.
 */

interface ClaimRow {
  id: string;
  code: string;
  claimant_member_id: string | null;
  claimant_user_id: string | null;
  claimant_name: string;
  title: string;
  justification: string;
  notes: string | null;
  category: ClaimCategory;
  amount_cents: number;
  spent_on: string;
  event_id: string | null;
  evidence_file_id: string;
  status: ClaimStatus;
  review_note: string | null;
  reviewed_at: string | null;
  transaction_id: string | null;
  created_at: string;
  event_title: string | null;
  reviewed_by_name: string | null;
}

const SELECT = `
  SELECT c.*, e.title AS event_title, u.name AS reviewed_by_name
  FROM expense_claims c
  LEFT JOIN events e ON e.id = c.event_id
  LEFT JOIN users u ON u.id = c.reviewed_by`;

const isReviewer = (actor: SessionUser) => actor.role === "admin" || actor.role === "treasurer";

/** True when `actor` is the person who filed the claim. */
function isClaimant(row: Pick<ClaimRow, "claimant_member_id" | "claimant_user_id">, actor: SessionUser): boolean {
  return actor.role === "member"
    ? row.claimant_member_id !== null && row.claimant_member_id === actor.memberId
    : row.claimant_user_id !== null && row.claimant_user_id === actor.id;
}

function toClaim(r: ClaimRow, actor: SessionUser): ExpenseClaim {
  return {
    id: r.id,
    code: r.code,
    claimantName: r.claimant_name,
    claimantKind: r.claimant_member_id ? "member" : "staff",
    isMine: isClaimant(r, actor),
    title: r.title,
    justification: r.justification,
    notes: r.notes,
    category: r.category,
    amountCents: r.amount_cents,
    spentOn: r.spent_on,
    eventId: r.event_id,
    eventTitle: r.event_title,
    evidenceFileId: r.evidence_file_id,
    status: r.status,
    reviewNote: r.review_note,
    reviewedByName: r.reviewed_by_name,
    reviewedAt: r.reviewed_at,
    transactionId: r.transaction_id,
    createdAt: r.created_at,
  };
}

/**
 * Who may file a claim: any committee account, and any member who is a
 * volunteer, meaning the committee has assigned them at least one task.
 */
export async function claimAccess(actor: SessionUser | null): Promise<ClaimAccess> {
  if (!actor) throw unauthorized();
  if (actor.role !== "member") return { canSubmit: true, canReview: isReviewer(actor), reason: null };
  const volunteer = !!await get("SELECT 1 FROM tasks WHERE assignee_member_id = ? LIMIT 1", actor.memberId);
  return {
    canSubmit: volunteer,
    canReview: false,
    reason: volunteer ? null : "Expense claims are for volunteers. Once the committee assigns you a task, you can claim what you spend on it.",
  };
}

export async function submitClaim(input: ClaimInput, evidence: Buffer | null, actor: SessionUser | null): Promise<ExpenseClaim> {
  const access = await claimAccess(actor);
  const user = actor!;
  if (!access.canSubmit) throw forbidden(access.reason ?? undefined);
  if (!evidence) {
    throw invalid("Add a photo of the receipt.", { evidence: "A photo of the receipt or bill is required" });
  }
  if (input.spentOn > today()) {
    throw invalid("Check the expense date.", { spentOn: "The expense date cannot be in the future" });
  }
  if (input.eventId && !await get("SELECT 1 FROM events WHERE id = ?", input.eventId)) {
    throw invalid("Choose an existing event.", { eventId: "This event no longer exists" });
  }

  let fileId = null as string | null;
  try {
    return tx(async () => {
      fileId = await storeImage(evidence, "claim_receipt");
      const id = newId("clm");
      let code = `CLM-${randomCode(6)}`;
      while (await get("SELECT 1 FROM expense_claims WHERE code = ?", code)) code = `CLM-${randomCode(6)}`;
      await run(
        `INSERT INTO expense_claims
           (id, code, claimant_member_id, claimant_user_id, claimant_name, title, justification, notes,
            category, amount_cents, spent_on, event_id, evidence_file_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?)`,
        id,
        code,
        // The claimant is always the signed-in account, never a value from the form.
        user.role === "member" ? user.memberId : null,
        user.role === "member" ? null : user.id,
        user.name,
        input.title,
        input.justification,
        input.notes,
        input.category,
        input.amountCents,
        input.spentOn,
        input.eventId,
        fileId,
        nowIso(),
      );
      return toClaim(await loadClaim(id), user);
    });
  } catch (error) {
    if (fileId) await discardFile(fileId);
    throw error;
  }
}

async function loadClaim(id: string): Promise<ClaimRow> {
  const row = await get<ClaimRow>(`${SELECT} WHERE c.id = ?`, id);
  if (!row) throw notFound("Claim");
  return row;
}

/** Reviewers see every claim; everyone else sees only their own. */
export async function listClaims(actor: SessionUser | null): Promise<ClaimList> {
  const access = await claimAccess(actor);
  const user = actor!;
  const order = "ORDER BY (c.status IN ('rejected','paid')), c.created_at DESC LIMIT 500";
  const rows = access.canReview
    ? await all<ClaimRow>(`${SELECT} ${order}`)
    : user.role === "member"
      ? await all<ClaimRow>(`${SELECT} WHERE c.claimant_member_id = ? ${order}`, user.memberId)
      : await all<ClaimRow>(`${SELECT} WHERE c.claimant_user_id = ? ${order}`, user.id);
  return { ...access, claims: rows.map((r) => toClaim(r, user)) };
}

/**
 * A reviewer moves a claim along: start_review, approve, reject or pay.
 * Every UPDATE names the statuses it applies to, so a claim cannot be approved
 * twice and so cannot reach the ledger twice.
 */
export async function reviewClaim(id: string, input: ClaimReviewInput, actor: SessionUser | null): Promise<ExpenseClaim> {
  const user = requireRole(actor, "admin", "treasurer");
  return tx(async () => {
    const row = await loadClaim(id);
    if (isClaimant(row, user)) {
      throw forbidden("You cannot review your own claim. Ask the other reviewer.");
    }
    const ts = nowIso();
    const refuse = () => conflict("invalid_claim_status", "This claim has already moved on. Reload to see where it stands.");

    if (input.action === "start_review") {
      const changed = await run(
        "UPDATE expense_claims SET status = 'under_review', reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'submitted'",
        user.id,
        ts,
        id,
      );
      if (changed.changes !== 1) throw refuse();
    }

    if (input.action === "reject") {
      const changed = await run(
        `UPDATE expense_claims SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ?
         WHERE id = ? AND status IN ('submitted','under_review')`,
        input.reason,
        user.id,
        ts,
        id,
      );
      if (changed.changes !== 1) throw refuse();
    }

    if (input.action === "approve") {
      const changed = await run(
        `UPDATE expense_claims SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ?
         WHERE id = ? AND status IN ('submitted','under_review')`,
        input.note,
        user.id,
        ts,
        id,
      );
      if (changed.changes !== 1) throw refuse();
      // The one place a claim enters the books: money now owed to the claimant.
      const transactionId = await recordTransaction({
        type: "expense",
        category: row.category,
        amountCents: row.amount_cents,
        status: "pending",
        occurredOn: row.spent_on,
        description: `Claim ${row.code} — ${row.title}`,
        counterparty: row.claimant_name,
        source: "manual",
        eventId: row.event_id,
        memberId: row.claimant_member_id,
        createdBy: user.id,
      });
      await run("UPDATE expense_claims SET transaction_id = ? WHERE id = ?", transactionId, id);
    }

    if (input.action === "pay") {
      if (row.status !== "approved" || !row.transaction_id) {
        throw conflict("not_approved", "Only an approved claim can be paid.");
      }
      // Goes through the ledger's own settlement, which marks the claim paid.
      await settleTransaction(row.transaction_id, input.method, user);
    }

    return toClaim(await loadClaim(id), user);
  });
}

/** Whether `actor` may open the receipt photo with this file id: reviewers and the claimant. */
export async function mayReadClaimEvidence(fileId: string, actor: SessionUser): Promise<boolean | null> {
  const row = await get<Pick<ClaimRow, "claimant_member_id" | "claimant_user_id">>(
    "SELECT claimant_member_id, claimant_user_id FROM expense_claims WHERE evidence_file_id = ?",
    fileId,
  );
  if (!row) return null;
  return isReviewer(actor) || isClaimant(row, actor);
}
