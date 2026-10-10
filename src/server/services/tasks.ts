import {
  TASK_STATUS_LABELS,
  type SessionUser,
  type Task,
  type TaskAction,
  type TaskInput,
  type TaskStatus,
} from "@/lib/contracts";
import { daysBetween } from "@/lib/dates";
import { all, get, newId, nowIso, run, today } from "../db";
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
}

const SELECT = `
  SELECT t.*, e.title AS event_title
  FROM tasks t LEFT JOIN events e ON e.id = t.event_id`;

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
  };
}

export function listTasks(): Task[] {
  const on = today();
  return all<TaskRow>(`${SELECT} ${ORDER}`).map((r) => toTask(r, on));
}

/** The tasks assigned to one member. */
export function listMemberTasks(memberId: string): Task[] {
  const on = today();
  return all<TaskRow>(`${SELECT} WHERE t.assignee_member_id = ? ${ORDER}`, memberId).map((r) => toTask(r, on));
}

export function getTask(id: string): Task {
  const row = get<TaskRow>(`${SELECT} WHERE t.id = ?`, id);
  if (!row) throw notFound("Task");
  return toTask(row, today());
}

function assertEvent(eventId: string | null): void {
  if (eventId && !get("SELECT 1 FROM events WHERE id = ?", eventId)) {
    throw invalid("Choose an existing event.", { eventId: "This event no longer exists" });
  }
}

/** When a member is chosen, the displayed name is always that member's name. */
function resolveAssignee(input: TaskInput): { assignee: string | null; memberId: string | null } {
  if (!input.assigneeMemberId) return { assignee: input.assignee, memberId: null };
  const member = get<{ name: string }>("SELECT name FROM members WHERE id = ?", input.assigneeMemberId);
  if (!member) throw invalid("Choose an existing member.", { assigneeMemberId: "This member no longer exists" });
  return { assignee: member.name, memberId: input.assigneeMemberId };
}

/** Staff only. New tasks always start in To do. */
export function createTask(input: TaskInput, actor: SessionUser | null): Task {
  const user = requireRole(actor, "admin", "organizer", "treasurer");
  assertEvent(input.eventId);
  const who = resolveAssignee(input);
  const id = newId("tsk");
  run(
    `INSERT INTO tasks
       (id, title, description, assignee, assignee_member_id, due_on, status, event_id, created_by, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, NULL)`,
    id,
    input.title,
    input.description,
    who.assignee,
    who.memberId,
    input.dueOn,
    input.eventId,
    user.id,
    nowIso(),
  );
  return getTask(id);
}

/** Staff only. Edits the details and the assignment; the status is left alone. */
export function updateTask(id: string, input: TaskInput, actor: SessionUser | null): Task {
  requireRole(actor, "admin", "organizer", "treasurer");
  getTask(id);
  assertEvent(input.eventId);
  const who = resolveAssignee(input);
  run(
    "UPDATE tasks SET title = ?, description = ?, assignee = ?, assignee_member_id = ?, due_on = ?, event_id = ? WHERE id = ?",
    input.title,
    input.description,
    who.assignee,
    who.memberId,
    input.dueOn,
    input.eventId,
    id,
  );
  return getTask(id);
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
export function transitionTask(id: string, action: TaskAction, actor: SessionUser | null): Task {
  if (!actor) throw unauthorized();
  const row = get<TaskRow>(`${SELECT} WHERE t.id = ?`, id);
  if (actor.role === "member") {
    if (!row || !actor.memberId || row.assignee_member_id !== actor.memberId) throw notFound("Task");
  } else {
    requireRole(actor, "admin", "organizer", "treasurer");
    if (!row) throw notFound("Task");
  }

  const step = TRANSITIONS[action];
  if (!step) throw invalid("Choose start, done or reopen.");
  const changed = run(
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
}

export function deleteTask(id: string, actor: SessionUser | null): void {
  requireRole(actor, "admin", "organizer");
  if (run("DELETE FROM tasks WHERE id = ?", id).changes !== 1) throw notFound("Task");
}
