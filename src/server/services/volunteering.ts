import type {
  MemberVolunteering,
  MyVolunteerRequest,
  SessionUser,
  TaskStatus,
  VolunteerOpportunity,
  VolunteerRequest,
  VolunteerRequestStatus,
  VolunteerReview,
} from "@/lib/contracts";
import { all, get, newId, nowIso, run, tx } from "../db";
import { conflict, forbidden, notFound, requireRole } from "../errors";

/**
 * Volunteering.
 *
 * The committee opens a task to volunteers by giving it a number of positions
 * (`tasks.volunteer_slots`). A member asks to help; that is a pending request
 * and nothing more. An organizer or the president approves or rejects it.
 * Approval is the assignment: the task then appears in the member's own task
 * list and they can progress it, exactly as for a task assigned to them
 * directly. Nothing a member sends can approve a request.
 *
 * Positions are taken by approved volunteers only. Pending requests are shown
 * separately and hold nothing. Requesting, withdrawing and reviewing each run
 * in one write transaction, and write transactions never overlap, so two
 * approvals at the same moment cannot both take the last position.
 */

interface OpenTaskRow {
  id: string;
  title: string;
  description: string;
  due_on: string | null;
  status: TaskStatus;
  volunteer_slots: number;
  assignee_member_id: string | null;
  event_id: string | null;
  event_title: string | null;
  event_starts_at: string | null;
  event_venue: string | null;
  approved: number;
  pending: number;
}

const TASK_SELECT = `
  SELECT t.id, t.title, t.description, t.due_on, t.status, t.volunteer_slots, t.assignee_member_id, t.event_id,
         e.title AS event_title, e.starts_at AS event_starts_at, e.venue AS event_venue,
         (SELECT COUNT(*) FROM volunteer_requests v WHERE v.task_id = t.id AND v.status = 'approved') AS approved,
         (SELECT COUNT(*) FROM volunteer_requests v WHERE v.task_id = t.id AND v.status = 'pending') AS pending
  FROM tasks t LEFT JOIN events e ON e.id = t.event_id`;

/**
 * A task members may ask to help with: the committee gave it positions, it is
 * not finished, and its event (if it has one) is published and not over.
 */
const OPEN_TO_VOLUNTEERS = `t.volunteer_slots > 0 AND t.status <> 'done'
  AND (t.event_id IS NULL OR (e.status = 'published' AND e.ends_at > ?))`;

const remaining = (row: { volunteer_slots: number; approved: number }) => Math.max(0, row.volunteer_slots - row.approved);

// --- the member's side ----------------------------------------------------------

interface MyRequestRow {
  id: string;
  task_id: string;
  task_title: string;
  event_title: string | null;
  event_starts_at: string | null;
  status: VolunteerRequestStatus;
  requested_at: string;
  reviewed_at: string | null;
  review_note: string | null;
}

/** Tasks open to volunteers, with counts only, and the member's own requests. */
export async function memberVolunteering(memberId: string): Promise<MemberVolunteering> {
  const mine = await all<MyRequestRow>(
    `SELECT v.id, v.task_id, t.title AS task_title, e.title AS event_title, e.starts_at AS event_starts_at,
            v.status, v.requested_at, v.reviewed_at, v.review_note
     FROM volunteer_requests v JOIN tasks t ON t.id = v.task_id LEFT JOIN events e ON e.id = t.event_id
     WHERE v.member_id = ? ORDER BY v.requested_at DESC, v.id`,
    memberId,
  );
  const live = new Map(
    mine.filter((r) => r.status === "pending" || r.status === "approved").map((r) => [r.task_id, { id: r.id, status: r.status }]),
  );
  // Open tasks, plus any the member already has a live request on (so an approved one does not vanish when it fills up).
  const tasks = await all<OpenTaskRow>(
    `${TASK_SELECT} WHERE ${OPEN_TO_VOLUNTEERS}
     ORDER BY (e.starts_at IS NULL), e.starts_at ASC, (t.due_on IS NULL), t.due_on ASC, t.title, t.id`,
    nowIso(),
  );
  const opportunities: VolunteerOpportunity[] = tasks.map((t) => ({
    taskId: t.id,
    title: t.title,
    description: t.description,
    dueOn: t.due_on,
    taskStatus: t.status,
    eventId: t.event_id,
    eventTitle: t.event_title,
    eventStartsAt: t.event_starts_at,
    eventVenue: t.event_venue,
    needed: t.volunteer_slots,
    approved: t.approved,
    pending: t.pending,
    remaining: remaining(t),
    isFull: remaining(t) === 0,
    myRequest: live.get(t.id) ?? null,
    assignedToMe: t.assignee_member_id === memberId,
  }));
  const requests: MyVolunteerRequest[] = mine.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    taskTitle: r.task_title,
    eventTitle: r.event_title,
    eventStartsAt: r.event_starts_at,
    status: r.status,
    requestedAt: r.requested_at,
    reviewedAt: r.reviewed_at,
    // A rejection reason is for the member; anything else stays with the committee.
    reviewNote: r.status === "rejected" ? r.review_note : null,
  }));
  return { opportunities, requests };
}

/**
 * A member asks to help with a task. This creates a pending request only: it
 * assigns nothing and takes no position. `memberId` comes from the session.
 */
export async function requestToVolunteer(memberId: string, taskId: string): Promise<MyVolunteerRequest> {
  const id = await tx(async () => {
    if (!(await get("SELECT 1 AS ok FROM members WHERE id = ?", memberId))) throw notFound("Member");
    const task = await get<OpenTaskRow>(`${TASK_SELECT} WHERE t.id = ? AND ${OPEN_TO_VOLUNTEERS}`, taskId, nowIso());
    // A task that is not open is reported the same as one that does not exist.
    if (!task) throw notFound("Volunteer opportunity");
    if (task.assignee_member_id === memberId) {
      throw conflict("already_assigned", "This task is already assigned to you.");
    }
    const existing = await get<{ status: VolunteerRequestStatus }>(
      "SELECT status FROM volunteer_requests WHERE task_id = ? AND member_id = ? AND status IN ('pending','approved')",
      taskId,
      memberId,
    );
    if (existing) {
      throw conflict(
        "already_requested",
        existing.status === "approved" ? "You are already approved for this task." : "You have already asked to volunteer for this task.",
      );
    }
    if (remaining(task) === 0) throw conflict("task_full", "This task already has all the volunteers it needs.");
    const requestId = newId("vol");
    await run(
      "INSERT INTO volunteer_requests (id, task_id, member_id, status, requested_at) VALUES (?, ?, ?, 'pending', ?)",
      requestId,
      taskId,
      memberId,
      nowIso(),
    );
    return requestId;
  });
  return (await memberVolunteering(memberId)).requests.find((r) => r.id === id)!;
}

/** A member takes back their own pending request. An approved one is the committee's to change. */
export async function withdrawVolunteerRequest(memberId: string, requestId: string): Promise<MyVolunteerRequest> {
  await tx(async () => {
    const row = await get<{ status: VolunteerRequestStatus }>(
      "SELECT status FROM volunteer_requests WHERE id = ? AND member_id = ?",
      requestId,
      memberId,
    );
    // Someone else's request looks the same as one that does not exist.
    if (!row) throw notFound("Request");
    if (row.status === "approved") {
      throw conflict("already_approved", "This request was approved. Ask an organizer if you can no longer help.");
    }
    if (row.status !== "pending") throw conflict("not_pending", "This request is no longer waiting for approval.");
    const updated = await run(
      "UPDATE volunteer_requests SET status = 'withdrawn', reviewed_at = ? WHERE id = ? AND member_id = ? AND status = 'pending'",
      nowIso(),
      requestId,
      memberId,
    );
    if (updated.changes !== 1) throw conflict("not_pending", "This request is no longer waiting for approval.");
  });
  return (await memberVolunteering(memberId)).requests.find((r) => r.id === requestId)!;
}

// --- the committee's side ---------------------------------------------------------

interface RequestRow {
  id: string;
  task_id: string;
  task_title: string;
  task_status: TaskStatus;
  volunteer_slots: number;
  event_id: string | null;
  event_title: string | null;
  event_starts_at: string | null;
  member_id: string;
  member_name: string;
  member_no: string;
  status: VolunteerRequestStatus;
  requested_at: string;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  review_note: string | null;
  approved: number;
}

const REQUEST_SELECT = `
  SELECT v.id, v.task_id, t.title AS task_title, t.status AS task_status, t.volunteer_slots,
         t.event_id, e.title AS event_title, e.starts_at AS event_starts_at,
         v.member_id, m.name AS member_name, m.member_no, v.status, v.requested_at, v.reviewed_at,
         u.name AS reviewed_by_name, v.review_note,
         (SELECT COUNT(*) FROM volunteer_requests a WHERE a.task_id = t.id AND a.status = 'approved') AS approved
  FROM volunteer_requests v
  JOIN tasks t ON t.id = v.task_id
  JOIN members m ON m.id = v.member_id
  LEFT JOIN events e ON e.id = t.event_id
  LEFT JOIN users u ON u.id = v.reviewed_by`;

const toRequest = (r: RequestRow): VolunteerRequest => ({
  id: r.id,
  taskId: r.task_id,
  taskTitle: r.task_title,
  eventId: r.event_id,
  eventTitle: r.event_title,
  eventStartsAt: r.event_starts_at,
  memberId: r.member_id,
  memberName: r.member_name,
  memberNo: r.member_no,
  status: r.status,
  requestedAt: r.requested_at,
  reviewedAt: r.reviewed_at,
  reviewedByName: r.reviewed_by_name,
  reviewNote: r.review_note,
  needed: r.volunteer_slots,
  approved: r.approved,
  remaining: remaining(r),
});

/** Only the president and event organizers review volunteers. A member account is never staff. */
function requireReviewer(actor: SessionUser | null): SessionUser {
  if (actor?.role === "member") throw forbidden("This area is for committee accounts.");
  return requireRole(actor, "admin", "organizer");
}

/** Volunteer requests, those waiting for a decision first (oldest first), then recent decisions. */
export async function listVolunteerRequests(actor: SessionUser | null): Promise<VolunteerRequest[]> {
  requireReviewer(actor);
  return (
    await all<RequestRow>(
      `${REQUEST_SELECT}
       ORDER BY (v.status <> 'pending'), CASE WHEN v.status = 'pending' THEN v.requested_at ELSE '' END ASC,
                v.reviewed_at DESC, v.id LIMIT 300`,
    )
  ).map(toRequest);
}

/**
 * Approves or rejects a pending request. Approving checks, inside the same
 * transaction that records it, that a position is still free; if the task
 * filled up first the approval is refused and nothing changes.
 */
export async function reviewVolunteerRequest(
  requestId: string,
  decision: VolunteerReview,
  actor: SessionUser | null,
): Promise<VolunteerRequest> {
  const reviewer = requireReviewer(actor);
  return tx(async () => {
    const row = await get<RequestRow>(`${REQUEST_SELECT} WHERE v.id = ?`, requestId);
    if (!row) throw notFound("Request");
    if (row.status !== "pending") throw conflict("already_reviewed", "This request has already been dealt with.");
    const ts = nowIso();

    if (decision.action === "approve") {
      if (row.task_status === "done") throw conflict("task_done", "This task is already finished.");
      if (remaining(row) === 0) {
        throw conflict("task_full", "No positions remain on this task, so the request cannot be approved.");
      }
    }
    const updated = await run(
      "UPDATE volunteer_requests SET status = ?, reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'pending'",
      decision.action === "approve" ? "approved" : "rejected",
      ts,
      reviewer.id,
      decision.action === "reject" ? decision.reason : null,
      requestId,
    );
    if (updated.changes !== 1) throw conflict("already_reviewed", "This request has already been dealt with.");
    return toRequest((await get<RequestRow>(`${REQUEST_SELECT} WHERE v.id = ?`, requestId))!);
  });
}
