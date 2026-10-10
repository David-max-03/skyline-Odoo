import { beforeEach, describe, expect, it } from "vitest";
import {
  TASK_ACTIONS,
  TASK_NEXT_ACTION,
  TASK_STATUSES,
  memberInputSchema,
  taskActionSchema,
  taskInputSchema,
  type TaskAction,
  type TaskStatus,
} from "@/lib/contracts";
import { completeSetup, createSetupToken, login } from "@/server/auth";
import { createMember } from "@/server/services/members";
import {
  createTask,
  deleteTask,
  getTask,
  listMemberTasks,
  transitionTask,
  updateTask,
} from "@/server/services/tasks";
import { appError, freshDb, type Staff } from "./helpers";

let staff: Staff;
beforeEach(() => {
  staff = freshDb();
});

function memberAccount(n: number) {
  const member = createMember(
    memberInputSchema.parse({ name: `Member ${n}`, email: `member${n}@campus.example`, duesPaid: true }),
    staff.treasurer,
  );
  completeSetup(createSetupToken(member.id, staff.admin.id).token, "a-long-test-password");
  return { member, user: login(member.memberNo, "a-long-test-password").user };
}

const newTask = (overrides: Record<string, unknown> = {}) =>
  createTask(taskInputSchema.parse({ title: "Set up chairs", ...overrides }), staff.organizer);

/** Puts a task into the given status using only legal steps. */
function taskIn(status: TaskStatus, overrides: Record<string, unknown> = {}) {
  const task = newTask(overrides);
  if (status !== "todo") transitionTask(task.id, "start", staff.organizer);
  if (status === "done") transitionTask(task.id, "done", staff.organizer);
  return getTask(task.id);
}

describe("task status", () => {
  it("offers exactly one action per status: start, done, reopen", () => {
    expect(TASK_NEXT_ACTION).toEqual({
      todo: { action: "start", label: "Start" },
      in_progress: { action: "done", label: "Done" },
      done: { action: "reopen", label: "Reopen" },
    });
    expect([...TASK_ACTIONS]).toEqual(["start", "done", "reopen"]);
  });

  it("moves to do → in progress → done, and reopens to in progress", () => {
    const task = newTask();
    expect(task.status).toBe("todo");
    expect(transitionTask(task.id, "start", staff.organizer).status).toBe("in_progress");
    const done = transitionTask(task.id, "done", staff.organizer);
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    const reopened = transitionTask(task.id, "reopen", staff.organizer);
    expect(reopened.status).toBe("in_progress");
    expect(reopened.completedAt).toBeNull();
    expect(transitionTask(task.id, "done", staff.organizer).status).toBe("done");
  });

  it("refuses every action that does not belong to the current status", () => {
    const allowed: Record<TaskStatus, TaskAction> = { todo: "start", in_progress: "done", done: "reopen" };
    for (const status of TASK_STATUSES) {
      for (const action of TASK_ACTIONS) {
        if (action === allowed[status]) continue;
        const task = taskIn(status);
        expect(appError(() => transitionTask(task.id, action, staff.organizer)).code, `${action} on ${status}`).toBe("invalid_transition");
        expect(getTask(task.id).status).toBe(status);
      }
    }
    // The same button pressed twice only works once.
    const task = newTask();
    transitionTask(task.id, "start", staff.organizer);
    expect(appError(() => transitionTask(task.id, "start", staff.organizer)).code).toBe("invalid_transition");
  });

  it("cannot be set directly: creating and editing ignore any status sent", () => {
    expect(taskActionSchema.safeParse({ status: "done" }).success).toBe(false);
    expect(taskActionSchema.safeParse({ action: "finish" }).success).toBe(false);
    const parsed = taskInputSchema.parse({ title: "Sneaky", status: "done" });
    expect("status" in parsed).toBe(false);
    const task = createTask(parsed, staff.organizer);
    expect(task.status).toBe("todo");

    const started = taskIn("in_progress");
    const edited = updateTask(started.id, taskInputSchema.parse({ title: "Renamed", status: "done" }), staff.organizer);
    expect(edited).toMatchObject({ title: "Renamed", status: "in_progress" });
  });
});

describe("tasks and member accounts", () => {
  it("lets a member progress their own tasks and see only those", () => {
    const a = memberAccount(1);
    const b = memberAccount(2);
    const mine = newTask({ title: "Mine", assigneeMemberId: a.member.id, assignee: "ignored" });
    newTask({ title: "Theirs", assigneeMemberId: b.member.id });
    newTask({ title: "Nobody's" });

    expect(mine).toMatchObject({ assignee: "Member 1", assigneeMemberId: a.member.id });
    expect(listMemberTasks(a.member.id).map((t) => t.title)).toEqual(["Mine"]);

    expect(transitionTask(mine.id, "start", a.user).status).toBe("in_progress");
    expect(transitionTask(mine.id, "done", a.user).status).toBe("done");
    expect(transitionTask(mine.id, "reopen", a.user).status).toBe("in_progress");
    expect(appError(() => transitionTask(mine.id, "start", a.user)).code).toBe("invalid_transition");
  });

  it("hides and protects tasks that are not the member's", () => {
    const a = memberAccount(1);
    const b = memberAccount(2);
    const theirs = newTask({ assigneeMemberId: b.member.id });
    const unassigned = newTask();

    for (const id of [theirs.id, unassigned.id, "tsk_missing"]) {
      expect(appError(() => transitionTask(id, "start", a.user)).status).toBe(404);
    }
    expect(getTask(theirs.id).status).toBe("todo");
    expect(appError(() => transitionTask(theirs.id, "start", null)).status).toBe(401);
  });

  it("does not let a member create, assign, edit or delete tasks", () => {
    const a = memberAccount(1);
    const b = memberAccount(2);
    const mine = newTask({ assigneeMemberId: a.member.id });
    const handOff = taskInputSchema.parse({ title: "Hand off", assigneeMemberId: b.member.id });

    expect(appError(() => createTask(handOff, a.user)).status).toBe(403);
    expect(appError(() => updateTask(mine.id, handOff, a.user)).status).toBe(403);
    expect(appError(() => deleteTask(mine.id, a.user)).status).toBe(403);
    expect(getTask(mine.id).assigneeMemberId).toBe(a.member.id);
  });

  it("keeps staff rules: any staff role moves tasks, reassignment follows the member record", () => {
    const a = memberAccount(1);
    const task = newTask({ assigneeMemberId: a.member.id });
    expect(transitionTask(task.id, "start", staff.treasurer).status).toBe("in_progress");
    expect(appError(() => newTask({ assigneeMemberId: "mem_missing" })).fields?.assigneeMemberId).toBeTruthy();

    // Unassigning takes the task off the member's list.
    updateTask(task.id, taskInputSchema.parse({ title: task.title, assignee: "An outside volunteer" }), staff.organizer);
    expect(getTask(task.id)).toMatchObject({ assignee: "An outside volunteer", assigneeMemberId: null, status: "in_progress" });
    expect(listMemberTasks(a.member.id)).toHaveLength(0);
    expect(appError(() => transitionTask(task.id, "done", a.user)).status).toBe(404);
    expect(appError(() => deleteTask(task.id, staff.treasurer)).status).toBe(403);
  });
});
