import type { SessionUser, Task, TaskInput, TaskStatus } from "@/lib/contracts";
import { daysBetween } from "@/lib/dates";
import { all, get, newId, nowIso, run, today } from "../db";
import { invalid, notFound, requireRole } from "../errors";

interface TaskRow {
  id: string;
  title: string;
  description: string;
  assignee: string | null;
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

function toTask(r: TaskRow, on: string): Task {
  const daysOverdue =
    r.status !== "done" && r.due_on && r.due_on < on ? daysBetween(r.due_on, on) : 0;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    assignee: r.assignee,
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
  // Open work first, soonest deadline first; undated tasks after dated ones.
  return all<TaskRow>(
    `${SELECT}
     ORDER BY (t.status = 'done'), (t.due_on IS NULL), t.due_on ASC, t.created_at DESC`,
  ).map((r) => toTask(r, on));
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

export function createTask(input: TaskInput, actor: SessionUser | null): Task {
  const user = requireRole(actor, "admin", "organizer", "treasurer");
  assertEvent(input.eventId);
  const id = newId("tsk");
  const ts = nowIso();
  run(
    `INSERT INTO tasks (id, title, description, assignee, due_on, status, event_id, created_by, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.title,
    input.description,
    input.assignee,
    input.dueOn,
    input.status,
    input.eventId,
    user.id,
    ts,
    input.status === "done" ? ts : null,
  );
  return getTask(id);
}

export function updateTask(id: string, input: TaskInput, actor: SessionUser | null): Task {
  requireRole(actor, "admin", "organizer", "treasurer");
  const existing = getTask(id);
  assertEvent(input.eventId);
  const completedAt = input.status === "done" ? (existing.completedAt ?? nowIso()) : null;
  run(
    `UPDATE tasks SET title = ?, description = ?, assignee = ?, due_on = ?, status = ?, event_id = ?, completed_at = ?
     WHERE id = ?`,
    input.title,
    input.description,
    input.assignee,
    input.dueOn,
    input.status,
    input.eventId,
    completedAt,
    id,
  );
  return getTask(id);
}

export function setTaskStatus(id: string, status: TaskStatus, actor: SessionUser | null): Task {
  requireRole(actor, "admin", "organizer", "treasurer");
  const existing = getTask(id);
  const completedAt = status === "done" ? (existing.completedAt ?? nowIso()) : null;
  run("UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?", status, completedAt, id);
  return getTask(id);
}

export function deleteTask(id: string, actor: SessionUser | null): void {
  requireRole(actor, "admin", "organizer");
  if (run("DELETE FROM tasks WHERE id = ?", id).changes !== 1) throw notFound("Task");
}
