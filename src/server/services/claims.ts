import {
  CAN,
  ROLE_LABELS,
  can,
  type ClaimAccess,
  type ClaimCategory,
  type ClaimInput,
  type ClaimList,
  type ClaimReviewInput,
  type ClaimStatus,
  type ClaimantOption,
  type ExpenseClaim,
  type Role,
  type SessionUser,
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
  /** The account that entered the claim for the claimant; null when the claimant filed it. */
  filed_by: string | null;
  event_title: string | null;
  reviewed_by_name: string | null;
  filed_by_name: string | null;
}

const SELECT = `
  SELECT c.*, e.title AS event_title, u.name AS reviewed_by_name, f.name AS filed_by_name
  FROM expense_claims c
  LEFT JOIN events e ON e.id = c.event_id
  LEFT JOIN users u ON u.id = c.reviewed_by
  LEFT JOIN users f ON f.id = c.filed_by`;

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
    filedByName: r.filed_by_name,
    filedByMe: r.filed_by !== null && actor.role !== "member" && r.filed_by === actor.id,
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
  if (actor.role !== "member") {
    return { canSubmit: true, canReview: isReviewer(actor), canFileForOthers: can(actor, "fileClaimForOthers"), reason: null };
  }
  const volunteer = !!await get("SELECT 1 FROM tasks WHERE assignee_member_id = ? LIMIT 1", actor.memberId);
  return {
    canSubmit: volunteer,
    canReview: false,
    canFileForOthers: false,
    reason: volunteer ? null : "Expense claims are for volunteers. Once the committee assigns you a task, you can claim what you spend on it.",
  };
}

/** A member is a volunteer, and so may claim, once the committee has assigned them a task. */
const VOLUNTEER = "EXISTS (SELECT 1 FROM tasks t WHERE t.assignee_member_id = m.id)";

/**
 * The people the president may file a claim for: active committee accounts
 * other than their own, and members who volunteer. The same rule decides who
 * may claim for themselves.
 */
export async function listClaimants(actor: SessionUser | null): Promise<ClaimantOption[]> {
  const user = requireRole(actor, ...CAN.fileClaimForOthers);
  const staff = await all<{ id: string; name: string; role: Role }>(
    "SELECT id, name, role FROM users WHERE disabled_at IS NULL AND id <> ? ORDER BY name, id",
    user.id,
  );
  const volunteers = await all<{ id: string; name: string; member_no: string }>(
    `SELECT m.id, m.name, m.member_no FROM members m WHERE ${VOLUNTEER} ORDER BY m.name, m.id`,
  );
  return [
    ...staff.map((s) => ({ kind: "staff" as const, id: s.id, name: s.name, detail: ROLE_LABELS[s.role] })),
    ...volunteers.map((v) => ({ kind: "member" as const, id: v.id, name: v.name, detail: v.member_no })),
  ];
}

interface Claimant {
  memberId: string | null;
  userId: string | null;
  name: string;
  /** The account that entered the claim, when it is not the claimant. */
  filedBy: string | null;
}

/**
 * Who the claim is for. Without a choice it is the signed-in account, as it
 * always was. With one, the caller must be the president and the chosen person
 * must exist and be allowed to claim: the name stored comes from their record,
 * never from the request.
 */
async function resolveClaimant(input: ClaimInput, user: SessionUser): Promise<Claimant> {
  if (!input.claimantKind && !input.claimantId) {
    return {
      memberId: user.role === "member" ? user.memberId : null,
      userId: user.role === "member" ? null : user.id,
      name: user.name,
      filedBy: null,
    };
  }
  requireRole(user, ...CAN.fileClaimForOthers);
  if (!input.claimantKind || !input.claimantId) {
    throw invalid("Choose who the claim is for.", { claimantId: "Choose who the claim is for" });
  }
  const unknown = () => invalid("Choose who the claim is for.", { claimantId: "This person cannot be found or cannot claim expenses" });
  if (input.claimantKind === "staff") {
    if (input.claimantId === user.id) {
      throw invalid("Choose someone else.", { claimantId: "To claim for yourself, leave this on \"Myself\"" });
    }
    const staff = await get<{ id: string; name: string }>(
      "SELECT id, name FROM users WHERE id = ? AND disabled_at IS NULL",
      input.claimantId,
    );
    if (!staff) throw unknown();
    return { memberId: null, userId: staff.id, name: staff.name, filedBy: user.id };
  }
  const member = await get<{ id: string; name: string }>(
    `SELECT m.id, m.name FROM members m WHERE m.id = ? AND ${VOLUNTEER}`,
    input.claimantId,
  );
  if (!member) throw unknown();
  return { memberId: member.id, userId: null, name: member.name, filedBy: user.id };
}

export async function submitClaim(input: ClaimInput, evidence: Buffer | null, actor: SessionUser | null): Promise<ExpenseClaim> {
  const access = await claimAccess(actor);
  const user = actor!;
  // A role that may not file for others is refused outright if it names a claimant, before anything else.
  if ((input.claimantKind || input.claimantId) && !access.canFileForOthers) throw forbidden();
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
      // Inside the transaction, so the person chosen still exists and may claim when the row is written.
      const claimant = await resolveClaimant(input, user);
      fileId = await storeImage(evidence, "claim_receipt");
      const id = newId("clm");
      let code = `CLM-${randomCode(6)}`;
      while (await get("SELECT 1 FROM expense_claims WHERE code = ?", code)) code = `CLM-${randomCode(6)}`;
      await run(
        `INSERT INTO expense_claims
           (id, code, claimant_member_id, claimant_user_id, claimant_name, title, justification, notes,
            category, amount_cents, spent_on, event_id, evidence_file_id, status, created_at, filed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`,
        id,
        code,
        // The signed-in account, or the person the president chose and the server checked.
        claimant.memberId,
        claimant.userId,
        claimant.name,
        input.title,
        input.justification,
        input.notes,
        input.category,
        input.amountCents,
        input.spentOn,
        input.eventId,
        fileId,
        nowIso(),
        claimant.filedBy,
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
    // Entering a claim for someone and then approving it would be reviewing one's own work.
    if (row.filed_by !== null && row.filed_by === user.id) {
      throw forbidden("You filed this claim on someone's behalf. Ask the other reviewer.");
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
