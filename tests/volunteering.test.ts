import { beforeEach, describe, expect, it } from "vitest";
import {
  memberInputSchema,
  taskInputSchema,
  volunteerReviewSchema,
  type Member,
  type MyVolunteerRequest,
  type SessionUser,
  type Task,
} from "@/lib/contracts";
import { all, get, setClock } from "@/server/db";
import { AppError } from "@/server/errors";
import { setEventStatus } from "@/server/services/events";
import { createMember } from "@/server/services/members";
import { createTask, deleteTask, getTask, listMemberTasks, listTasks, transitionTask, updateTask } from "@/server/services/tasks";
import {
  listVolunteerRequests,
  memberVolunteering,
  requestToVolunteer,
  reviewVolunteerRequest,
  withdrawVolunteerRequest,
} from "@/server/services/volunteering";
import { appError, freshDb, publishedEvent, type Staff } from "./helpers";

let staff: Staff;
let members: Member[];
let event: Awaited<ReturnType<typeof publishedEvent>>;

const asMember = (m: Member): SessionUser => ({ id: m.id, name: m.name, email: m.email, role: "member", memberId: m.id, memberNo: m.memberNo });

beforeEach(async () => {
  staff = await freshDb();
  members = [];
  for (let n = 1; n <= 6; n++) {
    members.push(await createMember(memberInputSchema.parse({ name: `Member ${n}`, email: `member${n}@campus.example`, duesPaid: true }), staff.admin));
  }
  event = await publishedEvent(staff, { title: "Winter Gala" });
});

const task = (overrides: Record<string, unknown> = {}): Promise<Task> =>
  createTask(taskInputSchema.parse({ title: "Run the welcome desk", eventId: event.id, volunteerSlots: 3, ...overrides }), staff.organizer);

const approve = (id: string, actor: SessionUser | null = staff.organizer) => reviewVolunteerRequest(id, { action: "approve" }, actor);
const opportunity = async (memberId: string, taskId: string) => (await memberVolunteering(memberId)).opportunities.find((o) => o.taskId === taskId);
const assigned = async (taskId: string) =>
  (await all<{ member_id: string }>("SELECT member_id FROM volunteer_requests WHERE task_id = ? AND status = 'approved' ORDER BY member_id", taskId)).map((r) => r.member_id);

describe("browsing volunteer opportunities", () => {
  it("shows only tasks the committee opened, with counts and nobody's name", async () => {
    const open = await task();
    await task({ title: "Committee only", volunteerSlots: 0 });
    const general = await task({ title: "Sort the storeroom", eventId: null, volunteerSlots: 1 });
    await approve((await requestToVolunteer(members[1].id, open.id)).id);
    await requestToVolunteer(members[2].id, open.id);

    const { opportunities } = await memberVolunteering(members[0].id);
    expect(opportunities.map((o) => o.title)).toEqual(["Run the welcome desk", "Sort the storeroom"]);
    expect(opportunities[0]).toMatchObject({
      eventTitle: "Winter Gala",
      eventVenue: "Hall A",
      needed: 3,
      approved: 1,
      pending: 1,
      remaining: 2,
      isFull: false,
      myRequest: null,
      assignedToMe: false,
    });
    expect(opportunities[1]).toMatchObject({ taskId: general.id, eventId: null, needed: 1, remaining: 1 });
    // Counts only: no other member's name, number or id is in what a member receives.
    const sent = JSON.stringify(await memberVolunteering(members[0].id));
    for (const other of [members[1], members[2]]) {
      expect(sent).not.toContain(other.name);
      expect(sent).not.toContain(other.memberNo);
      expect(sent).not.toContain(other.id);
    }
  });

  it("hides tasks that are finished or whose event is unpublished, cancelled or over", async () => {
    const done = await task({ title: "Done already" });
    await transitionTask(done.id, "start", staff.organizer);
    await transitionTask(done.id, "done", staff.organizer);
    const cancelled = await publishedEvent(staff, { title: "Cancelled night" });
    await task({ title: "For a cancelled event", eventId: cancelled.id });
    await setEventStatus(cancelled.id, "cancelled", staff.admin);
    const kept = await task({ title: "Still open" });

    expect((await memberVolunteering(members[0].id)).opportunities.map((o) => o.title)).toEqual(["Still open"]);
    expect((await appError(() => requestToVolunteer(members[0].id, done.id))).status).toBe(404);

    setClock(() => new Date(Date.now() + 10 * 86_400_000)); // the event is over
    expect((await memberVolunteering(members[0].id)).opportunities).toEqual([]);
    expect((await appError(() => requestToVolunteer(members[0].id, kept.id))).status).toBe(404);
  });
});

describe("requesting a task", () => {
  it("creates a pending request and assigns nothing", async () => {
    const t = await task();
    const request = await requestToVolunteer(members[0].id, t.id);
    expect(request).toMatchObject({ taskId: t.id, taskTitle: "Run the welcome desk", eventTitle: "Winter Gala", status: "pending", reviewedAt: null });

    expect(await listMemberTasks(members[0].id)).toEqual([]);
    expect(await assigned(t.id)).toEqual([]);
    expect((await getTask(t.id))).toMatchObject({ assigneeMemberId: null, approvedVolunteers: 0, pendingVolunteers: 1, status: "todo" });
    expect(await opportunity(members[0].id, t.id)).toMatchObject({ approved: 0, pending: 1, remaining: 3, myRequest: { id: request.id, status: "pending" } });
    // A member cannot move a task they have only asked for.
    expect((await appError(() => transitionTask(t.id, "start", asMember(members[0])))).status).toBe(404);
  });

  it("refuses a duplicate, a task that is full, one already assigned to the member, and an unknown task", async () => {
    const t = await task({ volunteerSlots: 1 });
    await requestToVolunteer(members[0].id, t.id);
    expect((await appError(() => requestToVolunteer(members[0].id, t.id))).code).toBe("already_requested");

    await approve((await requestToVolunteer(members[1].id, t.id)).id);
    expect((await appError(() => requestToVolunteer(members[1].id, t.id))).code).toBe("already_requested");
    expect((await appError(() => requestToVolunteer(members[2].id, t.id))).code).toBe("task_full");

    const mine = await task({ title: "Given to me", assigneeMemberId: members[3].id, volunteerSlots: 2 });
    expect((await appError(() => requestToVolunteer(members[3].id, mine.id))).code).toBe("already_assigned");
    expect((await appError(() => requestToVolunteer(members[3].id, "tsk_missing"))).status).toBe(404);
    expect((await appError(() => requestToVolunteer("mem_missing", t.id))).status).toBe(404);
    expect((await all("SELECT 1 FROM volunteer_requests")).length).toBe(2);
  });

  it("is stopped by the database if two identical requests ever got past the check", async () => {
    const t = await task();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => requestToVolunteer(members[0].id, t.id).then(() => "ok", (e: unknown) => (e as AppError).code)),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "already_requested")).toHaveLength(4);
    await expect(
      get("INSERT INTO volunteer_requests (id, task_id, member_id, status, requested_at) VALUES (?, ?, ?, 'pending', ?) RETURNING id", "vol_dup", t.id, members[0].id, "2026-01-01T00:00:00.000Z"),
    ).rejects.toThrow();
  });

  it("lets a member withdraw their own pending request, and only that", async () => {
    const t = await task({ volunteerSlots: 1 });
    const mine = await requestToVolunteer(members[0].id, t.id);
    const theirs = await requestToVolunteer(members[1].id, t.id);

    expect((await appError(() => withdrawVolunteerRequest(members[0].id, theirs.id))).status).toBe(404);
    expect((await withdrawVolunteerRequest(members[0].id, mine.id)).status).toBe("withdrawn");
    expect((await appError(() => withdrawVolunteerRequest(members[0].id, mine.id))).code).toBe("not_pending");
    expect(await opportunity(members[0].id, t.id)).toMatchObject({ pending: 1, remaining: 1, myRequest: null });
    // Having withdrawn, they may ask again.
    expect((await requestToVolunteer(members[0].id, t.id)).status).toBe("pending");

    await approve(theirs.id);
    expect((await appError(() => withdrawVolunteerRequest(members[1].id, theirs.id))).code).toBe("already_approved");
    expect(await assigned(t.id)).toEqual([members[1].id]);
  });

  it("shows a member their own requests and statuses, with the reason for a rejection", async () => {
    const a = await task({ title: "Task A" });
    const b = await task({ title: "Task B" });
    const c = await task({ title: "Task C" });
    await approve((await requestToVolunteer(members[0].id, a.id)).id);
    await reviewVolunteerRequest((await requestToVolunteer(members[0].id, b.id)).id, { action: "reject", reason: "We have enough people on the door." }, staff.admin);
    await requestToVolunteer(members[0].id, c.id);
    await requestToVolunteer(members[1].id, c.id);

    const { requests } = await memberVolunteering(members[0].id);
    expect(requests.map((r) => [r.taskTitle, r.status, r.reviewNote]).sort()).toEqual([
      ["Task A", "approved", null],
      ["Task B", "rejected", "We have enough people on the door."],
      ["Task C", "pending", null],
    ]);
    expect((await memberVolunteering(members[1].id)).requests.map((r) => r.taskTitle)).toEqual(["Task C"]);
  });
});

describe("approving and rejecting", () => {
  it("lets the president and organizers decide, and nobody else", async () => {
    const t = await task();
    const first = await requestToVolunteer(members[0].id, t.id);
    const second = await requestToVolunteer(members[1].id, t.id);

    for (const actor of [staff.treasurer, asMember(members[0]), asMember(members[2])]) {
      expect((await appError(() => approve(first.id, actor))).status).toBe(403);
      expect((await appError(() => reviewVolunteerRequest(first.id, { action: "reject", reason: null }, actor))).status).toBe(403);
      expect((await appError(() => listVolunteerRequests(actor))).status).toBe(403);
    }
    expect((await appError(() => approve(first.id, null))).status).toBe(401);
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM volunteer_requests WHERE status = 'pending'"))!.n).toBe(2);

    expect((await approve(first.id, staff.organizer)).status).toBe("approved");
    expect((await approve(second.id, staff.admin)).status).toBe("approved");
  });

  it("assigns the member on approval, exactly once, without finishing the task", async () => {
    const t = await task();
    const request = await requestToVolunteer(members[0].id, t.id);
    const approved = await approve(request.id);
    expect(approved).toMatchObject({ status: "approved", memberName: "Member 1", memberNo: members[0].memberNo, taskTitle: "Run the welcome desk", eventTitle: "Winter Gala", needed: 3, approved: 1, remaining: 2, reviewedByName: "Organizer" });

    expect(await assigned(t.id)).toEqual([members[0].id]);
    const mine = await listMemberTasks(members[0].id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: t.id, status: "todo", approvedVolunteers: 1, pendingVolunteers: 0 });
    expect(await listMemberTasks(members[1].id)).toEqual([]);

    // Approving again is refused and adds nothing.
    expect((await appError(() => approve(request.id))).code).toBe("already_reviewed");
    expect((await appError(() => reviewVolunteerRequest(request.id, { action: "reject", reason: null }, staff.admin))).code).toBe("already_reviewed");
    expect(await assigned(t.id)).toEqual([members[0].id]);

    // The volunteer can now progress the task like any assignee; others still cannot.
    expect((await transitionTask(t.id, "start", asMember(members[0]))).status).toBe("in_progress");
    expect((await appError(() => transitionTask(t.id, "done", asMember(members[1])))).status).toBe(404);
  });

  it("creates no assignment on rejection and leaves the position open", async () => {
    const t = await task({ volunteerSlots: 1 });
    const request = await requestToVolunteer(members[0].id, t.id);
    const rejected = await reviewVolunteerRequest(request.id, volunteerReviewSchema.parse({ action: "reject", reason: "  Not this time.  " }), staff.organizer);
    expect(rejected).toMatchObject({ status: "rejected", reviewNote: "Not this time.", approved: 0, remaining: 1 });
    expect(await assigned(t.id)).toEqual([]);
    expect(await listMemberTasks(members[0].id)).toEqual([]);
    expect(await opportunity(members[1].id, t.id)).toMatchObject({ approved: 0, pending: 0, remaining: 1, isFull: false });
    expect((await requestToVolunteer(members[1].id, t.id)).status).toBe("pending");
    // A rejected member may ask again later; the earlier request stays on record.
    expect((await requestToVolunteer(members[0].id, t.id)).status).toBe("pending");
    expect((await memberVolunteering(members[0].id)).requests.map((r) => r.status).sort()).toEqual(["pending", "rejected"]);
  });

  it("counts down positions as volunteers are approved and refuses once the task is full", async () => {
    const t = await task({ volunteerSlots: 3 });
    const requests: MyVolunteerRequest[] = [];
    for (const m of members.slice(0, 4)) requests.push(await requestToVolunteer(m.id, t.id));
    const seen: [number, number, number, boolean][] = [];
    for (const r of requests.slice(0, 3)) {
      await approve(r.id);
      const o = (await opportunity(members[5].id, t.id))!;
      seen.push([o.approved, o.pending, o.remaining, o.isFull]);
    }
    expect(seen).toEqual([[1, 3, 2, false], [2, 2, 1, false], [3, 1, 0, true]]);

    const refused = await appError(() => approve(requests[3].id));
    expect(refused).toMatchObject({ code: "task_full", status: 409 });
    expect(refused.message).toContain("No positions remain");
    expect((await assigned(t.id)).length).toBe(3);
    expect((await listVolunteerRequests(staff.admin)).find((r) => r.id === requests[3].id)).toMatchObject({ status: "pending", remaining: 0 });
    expect((await appError(() => requestToVolunteer(members[4].id, t.id))).code).toBe("task_full");
  });

  it("cannot be overbooked by approvals arriving at the same moment", async () => {
    const t = await task({ volunteerSlots: 2 });
    const requests: MyVolunteerRequest[] = [];
    for (const m of members) requests.push(await requestToVolunteer(m.id, t.id));
    const results = await Promise.all(
      requests.map((r, i) => approve(r.id, i % 2 ? staff.admin : staff.organizer).then(() => "approved", (e: unknown) => (e as AppError).code)),
    );
    expect(results.filter((r) => r === "approved")).toHaveLength(2);
    expect(results.filter((r) => r === "task_full")).toHaveLength(4);
    expect((await assigned(t.id)).length).toBe(2);
    expect(await getTask(t.id)).toMatchObject({ approvedVolunteers: 2, pendingVolunteers: 4 });
  });

  it("lists requests for reviewers, pending first", async () => {
    const t = await task();
    const a = await requestToVolunteer(members[0].id, t.id);
    const b = await requestToVolunteer(members[1].id, t.id);
    await approve(a.id);
    const list = await listVolunteerRequests(staff.organizer);
    expect(list.map((r) => [r.id, r.status])).toEqual([[b.id, "pending"], [a.id, "approved"]]);
    expect(list[0]).toMatchObject({ memberName: "Member 2", memberNo: members[1].memberNo, taskTitle: "Run the welcome desk", eventTitle: "Winter Gala" });
  });
});

describe("the existing task system", () => {
  it("keeps direct assignment, progression and committee management working", async () => {
    const direct = await createTask(taskInputSchema.parse({ title: "Print posters", assigneeMemberId: members[0].id }), staff.admin);
    expect(direct).toMatchObject({ volunteerSlots: 0, approvedVolunteers: 0, assigneeMemberId: members[0].id });
    expect((await listMemberTasks(members[0].id)).map((t) => t.id)).toEqual([direct.id]);
    expect((await transitionTask(direct.id, "start", asMember(members[0]))).status).toBe("in_progress");
    expect((await transitionTask(direct.id, "done", staff.organizer)).status).toBe("done");
    expect((await memberVolunteering(members[1].id)).opportunities).toEqual([]); // never offered to volunteers

    const edited = await updateTask(direct.id, taskInputSchema.parse({ title: "Print and hang posters", assigneeMemberId: members[0].id, volunteerSlots: 2 }), staff.organizer);
    expect(edited).toMatchObject({ title: "Print and hang posters", status: "done", volunteerSlots: 2 });
    expect((await listTasks()).map((t) => t.title)).toContain("Print and hang posters");
  });

  it("will not reduce a task below the volunteers already approved, and removes requests with the task", async () => {
    const t = await task({ volunteerSlots: 2 });
    await approve((await requestToVolunteer(members[0].id, t.id)).id);
    await approve((await requestToVolunteer(members[1].id, t.id)).id);
    const error = await appError(() => updateTask(t.id, taskInputSchema.parse({ title: t.title, eventId: event.id, volunteerSlots: 1 }), staff.organizer));
    expect(error.fields?.volunteerSlots).toContain("2 volunteers");
    expect((await getTask(t.id)).volunteerSlots).toBe(2);
    expect(taskInputSchema.safeParse({ title: "Bad", volunteerSlots: -1 }).success).toBe(false);
    expect(taskInputSchema.safeParse({ title: "Bad", volunteerSlots: 1.5 }).success).toBe(false);
    expect(taskInputSchema.parse({ title: "Default" }).volunteerSlots).toBe(0);

    await deleteTask(t.id, staff.organizer);
    expect(await get("SELECT 1 FROM volunteer_requests WHERE task_id = ?", t.id)).toBeUndefined();
    expect(await listMemberTasks(members[0].id)).toEqual([]);
  });
});
