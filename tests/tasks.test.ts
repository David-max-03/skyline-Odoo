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
beforeEach(async () => {
  staff = await freshDb();
});

async function memberAccount(n: number) {
  const member = await createMember(
    memberInputSchema.parse({ name: `Member ${n}`, email: `member${n}@campus.example`, duesPaid: true }),
    staff.treasurer,
  );
  await completeSetup((await createSetupToken(member.id, staff.admin.id)).token, "a-long-test-password");
  return { member, user: (await login(member.memberNo, "a-long-test-password")).user };
}

const newTask = (overrides: Record<string, unknown> = {}) =>
  createTask(taskInputSchema.parse({ title: "Set up chairs", ...overrides }), staff.organizer);

/** Puts a task into the given status using only legal steps. */
async function taskIn(status: TaskStatus, overrides: Record<string, unknown> = {}) {
  const task = await newTask(overrides);
  if (status !== "todo") await transitionTask(task.id, "start", staff.organizer);
  if (status === "done") await transitionTask(task.id, "done", staff.organizer);
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

  it("moves to do → in progress → done, and reopens to in progress", async () => {
    const task = await newTask();
    expect(task.status).toBe("todo");
    expect((await transitionTask(task.id, "start", staff.organizer)).status).toBe("in_progress");
    const done = await transitionTask(task.id, "done", staff.organizer);
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    const reopened = await transitionTask(task.id, "reopen", staff.organizer);
    expect(reopened.status).toBe("in_progress");
    expect(reopened.completedAt).toBeNull();
    expect((await transitionTask(task.id, "done", staff.organizer)).status).toBe("done");
  });

  it("refuses every action that does not belong to the current status", async () => {
    const allowed: Record<TaskStatus, TaskAction> = { todo: "start", in_progress: "done", done: "reopen" };
    for (const status of TASK_STATUSES) {
      for (const action of TASK_ACTIONS) {
        if (action === allowed[status]) continue;
        const task = await taskIn(status);
        expect((await appError(() => transitionTask(task.id, action, staff.organizer))).code, `${action} on ${status}`).toBe("invalid_transition");
        expect((await getTask(task.id)).status).toBe(status);
      }
    }
    // The same button pressed twice only works once.
    const task = await newTask();
    await transitionTask(task.id, "start", staff.organizer);
    expect((await appError(() => transitionTask(task.id, "start", staff.organizer))).code).toBe("invalid_transition");
  });

  it("cannot be set directly: creating and editing ignore any status sent", async () => {
    expect(taskActionSchema.safeParse({ status: "done" }).success).toBe(false);
    expect(taskActionSchema.safeParse({ action: "finish" }).success).toBe(false);
    const parsed = taskInputSchema.parse({ title: "Sneaky", status: "done" });
    expect("status" in parsed).toBe(false);
    const task = await createTask(parsed, staff.organizer);
    expect(task.status).toBe("todo");

    const started = await taskIn("in_progress");
    const edited = await updateTask(started.id, taskInputSchema.parse({ title: "Renamed", status: "done" }), staff.organizer);
    expect(edited).toMatchObject({ title: "Renamed", status: "in_progress" });
  });
});

describe("tasks and member accounts", () => {
  it("lets a member progress their own tasks and see only those", async () => {
    const a = await memberAccount(1);
    const b = await memberAccount(2);
    const mine = await newTask({ title: "Mine", assigneeMemberId: a.member.id, assignee: "ignored" });
    await newTask({ title: "Theirs", assigneeMemberId: b.member.id });
    await newTask({ title: "Nobody's" });

    expect(mine).toMatchObject({ assignee: "Member 1", assigneeMemberId: a.member.id });
    expect((await listMemberTasks(a.member.id)).map((t) => t.title)).toEqual(["Mine"]);

    expect((await transitionTask(mine.id, "start", a.user)).status).toBe("in_progress");
    expect((await transitionTask(mine.id, "done", a.user)).status).toBe("done");
    expect((await transitionTask(mine.id, "reopen", a.user)).status).toBe("in_progress");
    expect((await appError(() => transitionTask(mine.id, "start", a.user))).code).toBe("invalid_transition");
  });

  it("hides and protects tasks that are not the member's", async () => {
    const a = await memberAccount(1);
    const b = await memberAccount(2);
    const theirs = await newTask({ assigneeMemberId: b.member.id });
    const unassigned = await newTask();

    for (const id of [theirs.id, unassigned.id, "tsk_missing"]) {
      expect((await appError(() => transitionTask(id, "start", a.user))).status).toBe(404);
    }
    expect((await getTask(theirs.id)).status).toBe("todo");
    expect((await appError(() => transitionTask(theirs.id, "start", null))).status).toBe(401);
  });

  it("does not let a member create, assign, edit or delete tasks", async () => {
    const a = await memberAccount(1);
    const b = await memberAccount(2);
    const mine = await newTask({ assigneeMemberId: a.member.id });
    const handOff = taskInputSchema.parse({ title: "Hand off", assigneeMemberId: b.member.id });

    expect((await appError(() => createTask(handOff, a.user))).status).toBe(403);
    expect((await appError(() => updateTask(mine.id, handOff, a.user))).status).toBe(403);
    expect((await appError(() => deleteTask(mine.id, a.user))).status).toBe(403);
    expect((await getTask(mine.id)).assigneeMemberId).toBe(a.member.id);
  });

  it("keeps staff rules: any staff role moves tasks, reassignment follows the member record", async () => {
    const a = await memberAccount(1);
    const task = await newTask({ assigneeMemberId: a.member.id });
    expect((await transitionTask(task.id, "start", staff.treasurer)).status).toBe("in_progress");
    expect((await appError(() => newTask({ assigneeMemberId: "mem_missing" }))).fields?.assigneeMemberId).toBeTruthy();

    // Unassigning takes the task off the member's list.
    await updateTask(task.id, taskInputSchema.parse({ title: task.title, assignee: "An outside volunteer" }), staff.organizer);
    expect(await getTask(task.id)).toMatchObject({ assignee: "An outside volunteer", assigneeMemberId: null, status: "in_progress" });
    expect(await listMemberTasks(a.member.id)).toHaveLength(0);
    expect((await appError(() => transitionTask(task.id, "done", a.user))).status).toBe(404);
    expect((await appError(() => deleteTask(task.id, staff.treasurer))).status).toBe(403);
  });
});
