import {
  TASK_STATUS_LABELS,
  type SessionUser,
  type Task,
  type TaskAction,
  type TaskInput,
  type TaskStatus,
} from "@/lib/contracts";
import { daysBetween } from "@/lib/dates";
import { all, get, newId, nowIso, run, today, tx } from "../db";
import { conflict, invalid, notFound, requireRole, unauthorized } from "../errors";

/**
 * Volunteer tasks.
 *
 * Staff create, assign, edit and delete tasks. A task's status only ever
 * changes through `transitionTask`, one step at a time. A member may take
 * those steps on tasks assigned to them and can do nothing else to a task.
 */

interface TaskRow {
  id: string;
  title: string;
  description: string;
  assignee: string | null;
  assignee_member_id: string | null;
  due_on: string | null;
  status: TaskStatus;
  event_id: string | null;
  created_at: string;
  completed_at: string | null;
  event_title: string | null;
  volunteer_slots: number;
  approved_volunteers: number;
  pending_volunteers: number;
}

const SELECT = `
  SELECT t.*, e.title AS event_title,
    (SELECT COUNT(*) FROM volunteer_requests v WHERE v.task_id = t.id AND v.status = 'approved') AS approved_volunteers,
    (SELECT COUNT(*) FROM volunteer_requests v WHERE v.task_id = t.id AND v.status = 'pending') AS pending_volunteers
  FROM tasks t LEFT JOIN events e ON e.id = t.event_id`;

/** A member may see and progress a task assigned to them directly, or one they are an approved volunteer for. */
const IS_MINE = `(t.assignee_member_id = ? OR EXISTS (
  SELECT 1 FROM volunteer_requests v WHERE v.task_id = t.id AND v.member_id = ? AND v.status = 'approved'))`;

// Open work first, soonest deadline first; undated tasks after dated ones.
const ORDER = "ORDER BY (t.status = 'done'), (t.due_on IS NULL), t.due_on ASC, t.created_at DESC";

function toTask(r: TaskRow, on: string): Task {
  const daysOverdue =
    r.status !== "done" && r.due_on && r.due_on < on ? daysBetween(r.due_on, on) : 0;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    assignee: r.assignee,
    assigneeMemberId: r.assignee_member_id,
    dueOn: r.due_on,
    status: r.status,
    eventId: r.event_id,
    eventTitle: r.event_title,
    isOverdue: daysOverdue > 0,
    daysOverdue,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    volunteerSlots: r.volunteer_slots,
    approvedVolunteers: r.approved_volunteers,
    pendingVolunteers: r.pending_volunteers,
  };
}

export async function listTasks(): Promise<Task[]> {
  const on = today();
  return (await all<TaskRow>(`${SELECT} ${ORDER}`)).map((r) => toTask(r, on));
}

/** The tasks one member is on: assigned directly, or as an approved volunteer. */
export async function listMemberTasks(memberId: string): Promise<Task[]> {
  const on = today();
  return (await all<TaskRow>(`${SELECT} WHERE ${IS_MINE} ${ORDER}`, memberId, memberId)).map((r) => toTask(r, on));
}

export async function getTask(id: string): Promise<Task> {
  const row = await get<TaskRow>(`${SELECT} WHERE t.id = ?`, id);
  if (!row) throw notFound("Task");
  return toTask(row, today());
}

async function assertEvent(eventId: string | null): Promise<void> {
  if (eventId && !await get("SELECT 1 FROM events WHERE id = ?", eventId)) {
    throw invalid("Choose an existing event.", { eventId: "This event no longer exists" });
  }
}

/** When a member is chosen, the displayed name is always that member's name. */
async function resolveAssignee(input: TaskInput): Promise<{ assignee: string | null; memberId: string | null }> {
  if (!input.assigneeMemberId) return { assignee: input.assignee, memberId: null };
  const member = await get<{ name: string }>("SELECT name FROM members WHERE id = ?", input.assigneeMemberId);
  if (!member) throw invalid("Choose an existing member.", { assigneeMemberId: "This member no longer exists" });
  return { assignee: member.name, memberId: input.assigneeMemberId };
}

/** Staff only. New tasks always start in To do. */
export async function createTask(input: TaskInput, actor: SessionUser | null): Promise<Task> {
  const user = requireRole(actor, "admin", "organizer", "treasurer");
  await assertEvent(input.eventId);
  const who = await resolveAssignee(input);
  const id = newId("tsk");
  await run(
    `INSERT INTO tasks
       (id, title, description, assignee, assignee_member_id, due_on, status, event_id, created_by, created_at,
        completed_at, volunteer_slots)
     VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, NULL, ?)`,
    id,
    input.title,
    input.description,
    who.assignee,
    who.memberId,
    input.dueOn,
    input.eventId,
    user.id,
    nowIso(),
    input.volunteerSlots ?? 0,
  );
  return getTask(id);
}

/** Staff only. Edits the details and the assignment; the status is left alone. */
export async function updateTask(id: string, input: TaskInput, actor: SessionUser | null): Promise<Task> {
  requireRole(actor, "admin", "organizer", "treasurer");
  // Read and write together: the volunteer count checked here must still hold when the row is written.
  return tx(async () => {
    const current = await getTask(id);
    await assertEvent(input.eventId);
    const who = await resolveAssignee(input);
    const slots = input.volunteerSlots ?? 0;
    if (slots < current.approvedVolunteers) {
      throw invalid("Check the number of volunteers.", {
        volunteerSlots: `${current.approvedVolunteers} volunteers are already approved for this task`,
      });
    }
    await run(
      `UPDATE tasks SET title = ?, description = ?, assignee = ?, assignee_member_id = ?, due_on = ?, event_id = ?,
              volunteer_slots = ? WHERE id = ?`,
      input.title,
      input.description,
      who.assignee,
      who.memberId,
      input.dueOn,
      input.eventId,
      slots,
      id,
    );
    return getTask(id);
  });
}

const TRANSITIONS: Record<TaskAction, { from: TaskStatus; to: TaskStatus }> = {
  start: { from: "todo", to: "in_progress" },
  done: { from: "in_progress", to: "done" },
  reopen: { from: "done", to: "in_progress" },
};

/**
 * Moves a task one step: start, done or reopen. Staff may move any task. A
 * member may move only a task assigned to them; any other task looks missing
 * to them, so task ids reveal nothing.
 *
 * The UPDATE names the status it expects, so an action that does not apply to
 * the task's current status changes nothing, and two people pressing the same
 * button cannot both succeed.
 */
export async function transitionTask(id: string, action: TaskAction, actor: SessionUser | null): Promise<Task> {
  if (!actor) throw unauthorized();
  // The permission check and the change share one transaction, so a task
  // reassigned at the same moment cannot still be moved by its previous assignee.
  return tx(async () => {
    const row = await get<TaskRow>(`${SELECT} WHERE t.id = ?`, id);
    if (actor.role === "member") {
      // Assigned directly, or an approved volunteer. Anyone else is told the task does not exist.
      const mine =
        !!row && !!actor.memberId &&
        !!(await get(`SELECT 1 AS mine FROM tasks t WHERE t.id = ? AND ${IS_MINE}`, id, actor.memberId, actor.memberId));
      if (!row || !mine) throw notFound("Task");
    } else {
      requireRole(actor, "admin", "organizer", "treasurer");
      if (!row) throw notFound("Task");
    }

    const step = TRANSITIONS[action];
    if (!step) throw invalid("Choose start, done or reopen.");
    const changed = await run(
      "UPDATE tasks SET status = ?, completed_at = ? WHERE id = ? AND status = ?",
      step.to,
      step.to === "done" ? nowIso() : null,
      id,
      step.from,
    );
    if (changed.changes !== 1) {
      throw conflict(
        "invalid_transition",
        `This task is "${TASK_STATUS_LABELS[row.status]}", so it cannot be ${action === "start" ? "started" : action === "done" ? "marked done" : "reopened"}.`,
      );
    }
    return getTask(id);
  });
}

export async function deleteTask(id: string, actor: SessionUser | null): Promise<void> {
  requireRole(actor, "admin", "organizer");
  if ((await run("DELETE FROM tasks WHERE id = ?", id)).changes !== 1) throw notFound("Task");
}
