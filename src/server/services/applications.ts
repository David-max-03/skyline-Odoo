import QRCode from "qrcode";
import {
  SETTINGS,
  type ApplicationChannel,
  type ApplicationInput,
  type ApplicationMethod,
  type ApplicationReceipt,
  type ApplicationReview,
  type ApplicationStatus,
  type ApplicationStatusView,
  type MembershipApplication,
  type OnlineApplicationStatus,
  type PaymentInstructions,
  type SessionUser,
} from "@/lib/contracts";
import { all, get, newId, nowIso, randomCode, run, tx } from "../db";
import { AppError, conflict, forbidden, invalid, notFound, requireRole, unauthorized } from "../errors";
import { discardFile, openFile, storeImage, type StoredFile } from "../storage";
import { mayReadClaimEvidence } from "./claims";
import { admitMember, newSetupLink } from "./members";
import { onlinePaymentAvailable } from "./online-applications";

/**
 * Membership applications.
 *
 * This file is the manual route. (Paying online is in `online-applications.ts`;
 * it ends in a row here that is already approved, with `channel = 'razorpay'`.)
 *
 * Someone who wants to join pays the fee outside this system (UPI, bank
 * transfer or cash), then submits the payment reference and a screenshot.
 * That creates a pending application and nothing else: no member, no member
 * ID, no ledger entry. Nothing an applicant submits is treated as proof.
 *
 * A treasurer or admin then checks the club's own account. Only their
 * approval, with an explicit statement that the money arrived, creates the
 * member, records the dues as collected, and issues a password-setup link.
 */

interface ApplicationRow {
  id: string;
  code: string;
  name: string;
  email: string;
  student_id: string | null;
  phone: string | null;
  amount_cents: number;
  payment_method: ApplicationMethod;
  payment_reference: string;
  evidence_file_id: string | null;
  status: ApplicationStatus;
  review_note: string | null;
  reviewed_at: string | null;
  member_id: string | null;
  created_at: string;
  channel: ApplicationChannel;
  reviewed_by_name: string | null;
  member_no: string | null;
}

const SELECT = `
  SELECT a.*, u.name AS reviewed_by_name, m.member_no AS member_no
  FROM membership_applications a
  LEFT JOIN users u ON u.id = a.reviewed_by
  LEFT JOIN members m ON m.id = a.member_id`;

const toApplication = (r: ApplicationRow): MembershipApplication => ({
  id: r.id,
  code: r.code,
  name: r.name,
  email: r.email,
  studentId: r.student_id,
  phone: r.phone,
  amountCents: r.amount_cents,
  paymentMethod: r.payment_method,
  paymentReference: r.payment_reference,
  evidenceFileId: r.evidence_file_id,
  status: r.status,
  reviewNote: r.review_note,
  reviewedByName: r.reviewed_by_name,
  reviewedAt: r.reviewed_at,
  memberId: r.member_id,
  memberNo: r.member_no,
  channel: r.channel,
  createdAt: r.created_at,
});

// --- how to pay ----------------------------------------------------------------

const UPI_ID = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$/;

/**
 * Payment instructions for the join page. The QR code only encodes a request
 * to pay the club's UPI ID; scanning it tells this system nothing. Without a
 * configured UPI ID there is no QR code, rather than an invented one.
 */
export async function paymentInstructions(): Promise<PaymentInstructions> {
  const feeCents = SETTINGS.membershipFeeCents;
  const online = { available: onlinePaymentAvailable() };
  const vpa = process.env.SKYLINE_UPI_ID?.trim();
  const currency = process.env.NEXT_PUBLIC_CURRENCY ?? "INR";
  if (!vpa || !UPI_ID.test(vpa) || currency !== "INR" || feeCents <= 0) return { feeCents, upi: null, online };

  const payeeName = process.env.SKYLINE_UPI_PAYEE?.trim() || SETTINGS.orgName;
  const query = new URLSearchParams({
    pa: vpa,
    pn: payeeName,
    am: (feeCents / 100).toFixed(2),
    cu: "INR",
    tn: "Membership fee",
  })
    .toString()
    .replace(/\+/g, "%20");
  const qrSvg = await QRCode.toString(`upi://pay?${query}`, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0b1220", light: "#ffffff" },
  });
  return { feeCents, upi: { payeeName, vpa, qrSvg }, online };
}

// --- applying ------------------------------------------------------------------

/** Bank and UPI references are compared without spaces or case; a cash note is kept as written. */
const normaliseReference = (method: ApplicationMethod, reference: string) =>
  method === "cash" ? reference.trim() : reference.replace(/\s+/g, "").toUpperCase();

export function submitApplication(
  input: ApplicationInput,
  evidence: Buffer | null,
  actor: SessionUser | null = null,
): ApplicationReceipt {
  // Someone signed in as a member is one already, whatever email they type here.
  if (actor?.role === "member") {
    throw conflict("already_member", "You are already a member. Open My membership to see your details.");
  }
  if (input.paymentMethod !== "cash" && !evidence) {
    throw invalid("Add a screenshot of your payment.", {
      evidence: "Attach a screenshot or photo of the payment confirmation",
    });
  }
  const reference = normaliseReference(input.paymentMethod, input.paymentReference);

  let fileId = null as string | null;
  try {
    return tx(() => {
      if (get("SELECT 1 FROM members WHERE email = ?", input.email)) {
        throw conflict(
          "already_member",
          "This email already belongs to a member. Sign in, or ask the committee for a password link.",
        );
      }
      if (get("SELECT 1 FROM membership_applications WHERE email = ? AND status = 'pending'", input.email)) {
        throw conflict("application_pending", "An application for this email is already waiting for review.");
      }
      if (
        input.paymentMethod !== "cash" &&
        get(
          `SELECT 1 FROM membership_applications
           WHERE payment_method = ? AND payment_reference = ? AND status <> 'rejected'`,
          input.paymentMethod,
          reference,
        )
      ) {
        throw new AppError("reference_used", "This payment reference was already used.", 409, {
          paymentReference: "This reference is already on another application",
        });
      }

      fileId = evidence ? storeImage(evidence, "application_payment") : null;
      let code = `APP-${randomCode(6)}`;
      while (get("SELECT 1 FROM membership_applications WHERE code = ?", code)) code = `APP-${randomCode(6)}`;

      run(
        `INSERT INTO membership_applications
           (id, code, name, email, student_id, phone, amount_cents, payment_method, payment_reference,
            evidence_file_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        newId("app"),
        code,
        input.name,
        input.email,
        input.studentId,
        input.phone,
        SETTINGS.membershipFeeCents,
        input.paymentMethod,
        reference,
        fileId,
        nowIso(),
      );
      return { code, status: "pending" as const, amountCents: SETTINGS.membershipFeeCents };
    });
  } catch (error) {
    // The transaction rolled the file's row back; remove its bytes as well.
    if (fileId) discardFile(fileId);
    throw error;
  }
}

/**
 * Lets an applicant see where their application stands. Both the code and the
 * email must match, and a miss on either gives the same answer.
 */
export function getApplicationStatus(code: string, email: string): ApplicationStatusView {
  const row = get<ApplicationRow>(
    `${SELECT} WHERE a.code = ? AND a.email = ?`,
    code.trim().toUpperCase(),
    email.trim().toLowerCase(),
  );
  if (!row) {
    // An online application has no row here until its payment is verified.
    const online = get<{ code: string; status: OnlineApplicationStatus; created_at: string }>(
      "SELECT code, status, created_at FROM online_applications WHERE code = ? AND email = ?",
      code.trim().toUpperCase(),
      email.trim().toLowerCase(),
    );
    if (!online) throw notFound("Application");
    return {
      code: online.code,
      status: "pending",
      submittedAt: online.created_at,
      reviewNote: null,
      memberNo: null,
      online: online.status,
    };
  }
  return {
    code: row.code,
    status: row.status,
    submittedAt: row.created_at,
    reviewNote: row.status === "rejected" ? row.review_note : null,
    memberNo: row.member_no,
    online: null,
  };
}

// --- reviewing -----------------------------------------------------------------

export function listApplications(actor: SessionUser | null): MembershipApplication[] {
  requireRole(actor, "admin", "treasurer");
  return all<ApplicationRow>(`${SELECT} ORDER BY (a.status <> 'pending'), a.created_at DESC LIMIT 500`).map(
    toApplication,
  );
}

function loadApplication(id: string): ApplicationRow {
  const row = get<ApplicationRow>(`${SELECT} WHERE a.id = ?`, id);
  if (!row) throw notFound("Application");
  return row;
}

export type ReviewDecision =
  | { action: "approve"; paymentReceived: true }
  | { action: "reject"; reason: string };

export function reviewApplication(
  id: string,
  decision: ReviewDecision,
  actor: SessionUser | null,
): ApplicationReview {
  const user = requireRole(actor, "admin", "treasurer");
  return tx(() => {
    const row = loadApplication(id);
    if (row.status !== "pending") {
      throw conflict("already_reviewed", "This application has already been reviewed.");
    }
    const ts = nowIso();

    if (decision.action === "reject") {
      run(
        `UPDATE membership_applications
         SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ?
         WHERE id = ? AND status = 'pending'`,
        decision.reason,
        user.id,
        ts,
        id,
      );
      return { application: toApplication(loadApplication(id)), setup: null };
    }

    // Checked here as well as in the request schema: approval is the one step
    // that turns a claim of payment into money in the books.
    if (decision.paymentReceived !== true) {
      throw invalid("Confirm that the payment was received.", {
        paymentReceived: "Confirm that the payment was received",
      });
    }

    const member = admitMember(
      { name: row.name, email: row.email, studentId: row.student_id, phone: row.phone },
      { method: row.payment_method, reference: row.payment_reference, createdBy: user.id },
    );
    const updated = run(
      `UPDATE membership_applications
       SET status = 'approved', reviewed_by = ?, reviewed_at = ?, member_id = ?
       WHERE id = ? AND status = 'pending'`,
      user.id,
      ts,
      member.id,
      id,
    );
    if (updated.changes !== 1) {
      throw conflict("already_reviewed", "This application has already been reviewed.");
    }
    return { application: toApplication(loadApplication(id)), setup: newSetupLink(member.id, user.id) };
  });
}

// --- evidence ------------------------------------------------------------------

/**
 * Returns an uploaded evidence image to someone allowed to see it. A payment
 * screenshot shows a person's bank details, so only reviewers may open one.
 */
export function readEvidence(fileId: string, actor: SessionUser | null): StoredFile {
  if (!actor) throw unauthorized();
  if (get("SELECT 1 FROM membership_applications WHERE evidence_file_id = ?", fileId)) {
    requireRole(actor, "admin", "treasurer");
    return openFile(fileId);
  }
  // A receipt photo: the reviewers and the person who filed the claim.
  const claimAllowed = mayReadClaimEvidence(fileId, actor);
  if (claimAllowed === true) return openFile(fileId);
  if (claimAllowed === false) throw forbidden("This receipt belongs to someone else's claim.");
  throw notFound("File");
}
