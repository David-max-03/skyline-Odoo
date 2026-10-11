"use client";

import { ArrowRight, CalendarDays, Check, CircleAlert, Info, ListChecks, Pencil, Plus, RotateCcw, Trash2, User } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ConfirmDialog, Dialog, DialogActions, useToast } from "@/components/overlay";
import { useCan } from "@/components/session";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  FormError,
  LoadingBlock,
  Meter,
  Notice,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
  cn,
} from "@/components/ui";
import { VolunteerRequestsPanel } from "@/components/volunteer-requests-panel";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import { TASK_NEXT_ACTION, TASK_STATUSES, TASK_STATUS_LABELS, type EventView, type Member, type Task } from "@/lib/contracts";
import { formatDate } from "@/lib/dates";

export default function TasksPage() {
  const canManageTasks = useCan("manageTasks");
  if (!canManageTasks) {
    return (
      <>
        <PageHeader title="Volunteer tasks" />
        <Notice tone="neutral" icon={Info}>
          Volunteer tasks are run by the president and the event handler. Your role does not include them.
        </Notice>
      </>
    );
  }
  return <TaskBoard />;
}

function TaskBoard() {
  const toast = useToast();
  const canDelete = useCan("manageEvents");
  const canReviewVolunteers = useCan("reviewVolunteers");
  const tasks = useApi<Task[]>("/api/tasks");
  const events = useApi<EventView[]>("/api/events");
  const members = useApi<Member[]>("/api/members");
  const [eventFilter, setEventFilter] = useState("");
  const [editing, setEditing] = useState<Task | "new" | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const all = tasks.data ?? [];
  const visible = all.filter((t) => !eventFilter || (eventFilter === "none" ? !t.eventId : t.eventId === eventFilter));
  const done = visible.filter((t) => t.status === "done").length;
  const overdue = visible.filter((t) => t.isOverdue).length;
  const eventOptions = (events.data ?? []).filter((e) => e.status !== "cancelled");

  /** Takes the one step available from the task's current status. */
  async function advance(task: Task) {
    setBusy(task.id);
    try {
      await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { action: TASK_NEXT_ACTION[task.status].action } });
      tasks.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(deleting.id);
    try {
      await api(`/api/tasks/${deleting.id}`, { method: "DELETE" });
      toast.success("Task deleted.");
      setDeleting(null);
      tasks.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Volunteer tasks"
        description="Who is doing what, by when. Overdue work is flagged so nothing lives only in a group chat."
        actions={
          <Button icon={Plus} onClick={() => setEditing("new")}>
            New task
          </Button>
        }
      />

      {canReviewVolunteers && <VolunteerRequestsPanel onChanged={tasks.reload} />}

      {tasks.error && !tasks.data ? (
        <Card>
          <ErrorState message={tasks.error.message} onRetry={tasks.reload} />
        </Card>
      ) : !tasks.data ? (
        <Card>
          <LoadingBlock label="Loading tasks" rows={6} />
        </Card>
      ) : all.length === 0 ? (
        <Card>
          <EmptyState
            icon={ListChecks}
            title="No tasks yet"
            description="Break an event into tasks and give each one an owner and a due date."
            action={
              <Button icon={Plus} onClick={() => setEditing("new")}>
                New task
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <Card className="mb-5 grid gap-4 p-5 sm:grid-cols-[16rem_1fr] sm:items-end">
            <SelectField label="Show tasks for" value={eventFilter} onChange={(e) => setEventFilter(e.target.value)}>
              <option value="">Everything</option>
              <option value="none">Not tied to an event</option>
              {eventOptions.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </SelectField>
            <div>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium text-ink">
                  <span className="num">{done}</span> of <span className="num">{visible.length}</span> done
                </span>
                {overdue > 0 ? (
                  <Badge tone="bad" icon={CircleAlert}>
                    {overdue} overdue
                  </Badge>
                ) : (
                  visible.length > 0 && <Badge tone="ok">On track: nothing overdue</Badge>
                )}
              </div>
              <Meter value={done} max={visible.length} label="Tasks done" tone="ok" />
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            {TASK_STATUSES.map((status) => {
              const column = visible.filter((t) => t.status === status);
              return (
                <section key={status} aria-labelledby={`col-${status}`} className="rounded-card bg-sunken/70 p-3">
                  <h2 id={`col-${status}`} className="flex items-center justify-between px-1.5 pb-2.5 pt-1 text-sm font-semibold">
                    {TASK_STATUS_LABELS[status]}
                    <span className="num text-xs font-medium text-muted">{column.length}</span>
                  </h2>
                  {column.length === 0 ? (
                    <p className="rounded-control border border-dashed border-line-strong px-3 py-6 text-center text-[0.8125rem] text-muted">
                      Nothing here
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {column.map((task) => (
                        <li
                          key={task.id}
                          className={cn(
                            "rounded-control border bg-surface p-3.5 shadow-card",
                            task.isOverdue ? "border-bad/40" : "border-line",
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className={cn("text-sm font-medium text-ink", task.status === "done" && "text-muted line-through")}>{task.title}</p>
                            <div className="-mr-1.5 -mt-1 flex shrink-0">
                              <button
                                type="button"
                                onClick={() => setEditing(task)}
                                aria-label={`Edit ${task.title}`}
                                className="flex size-8 items-center justify-center rounded text-subtle hover:bg-sunken hover:text-ink"
                              >
                                <Pencil className="size-3.5" aria-hidden />
                              </button>
                              {canDelete && (
                                <button
                                  type="button"
                                  onClick={() => setDeleting(task)}
                                  aria-label={`Delete ${task.title}`}
                                  className="flex size-8 items-center justify-center rounded text-subtle hover:bg-bad-soft hover:text-bad"
                                >
                                  <Trash2 className="size-3.5" aria-hidden />
                                </button>
                              )}
                            </div>
                          </div>
                          {task.description && <p className="mt-1 text-[0.8125rem] text-muted">{task.description}</p>}
                          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-muted">
                            <span className="inline-flex items-center gap-1">
                              <User className="size-3.5" aria-hidden />
                              {task.assignee ?? <em className="not-italic text-warn">Unassigned</em>}
                            </span>
                            {task.dueOn && (
                              <span className={cn("inline-flex items-center gap-1", task.isOverdue && "font-medium text-bad")}>
                                <CalendarDays className="size-3.5" aria-hidden />
                                {task.isOverdue
                                  ? `${task.daysOverdue} ${task.daysOverdue === 1 ? "day" : "days"} overdue`
                                  : `Due ${formatDate(task.dueOn)}`}
                              </span>
                            )}
                          </div>
                          {task.volunteerSlots > 0 && (
                            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[0.8125rem]">
                              <Badge tone={task.approvedVolunteers >= task.volunteerSlots ? "ok" : "brand"}>
                                {task.approvedVolunteers >= task.volunteerSlots
                                  ? `Fully staffed · ${task.approvedVolunteers} of ${task.volunteerSlots}`
                                  : `${task.approvedVolunteers} of ${task.volunteerSlots} volunteers`}
                              </Badge>
                              {task.pendingVolunteers > 0 && <Badge tone="warn">{task.pendingVolunteers} pending</Badge>}
                            </p>
                          )}
                          {task.eventTitle && <p className="mt-1.5 text-xs text-subtle">{task.eventTitle}</p>}
                          <div className="mt-3 border-t border-line pt-3">
                            {/* One action per status: Start, then Done, then Reopen. */}
                            <Button
                              className="w-full"
                              icon={task.status === "todo" ? ArrowRight : task.status === "in_progress" ? Check : RotateCcw}
                              loading={busy === task.id}
                              aria-label={`${TASK_NEXT_ACTION[task.status].label}: ${task.title}`}
                              onClick={() => advance(task)}
                            >
                              {TASK_NEXT_ACTION[task.status].label}
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "New task" : "Edit task"}>
        {editing && (
          <TaskForm
            key={editing === "new" ? "new" : editing.id}
            task={editing === "new" ? undefined : editing}
            events={eventOptions}
            members={members.data ?? []}
            defaultEventId={eventFilter && eventFilter !== "none" ? eventFilter : ""}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              toast.success(editing === "new" ? "Task added." : "Task updated.");
              setEditing(null);
              tasks.reload();
            }}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title="Delete this task?"
        confirmLabel="Delete task"
        danger
        loading={busy === deleting?.id}
      >
        <p>“{deleting?.title}” will be removed for everyone. This cannot be undone.</p>
      </ConfirmDialog>
    </>
  );
}

function TaskForm({
  task,
  events,
  members,
  defaultEventId,
  onSaved,
  onCancel,
}: {
  task?: Task;
  events: EventView[];
  members: Member[];
  defaultEventId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState({
    title: task?.title ?? "",
    description: task?.description ?? "",
    // A member is chosen from the list; anyone else is typed in as a name.
    assignee: task?.assigneeMemberId ? "" : (task?.assignee ?? ""),
    assigneeMemberId: task?.assigneeMemberId ?? "",
    dueOn: task?.dueOn ?? "",
    volunteerSlots: String(task?.volunteerSlots ?? 0),
    eventId: task?.eventId ?? defaultEventId,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const body = {
        ...values,
        assignee: values.assigneeMemberId ? null : values.assignee || null,
        assigneeMemberId: values.assigneeMemberId || null,
        dueOn: values.dueOn || null,
        volunteerSlots: Number(values.volunteerSlots.trim() || 0),
        eventId: values.eventId || null,
      };
      await api(task ? `/api/tasks/${task.id}` : "/api/tasks", { method: task ? "PUT" : "POST", body });
      onSaved();
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <FormError message={formError} />
      <TextField label="What needs doing?" value={values.title} onChange={set("title")} error={errors.title} placeholder="Buy baking supplies" required autoFocus={!task} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Assign to a member"
          value={values.assigneeMemberId}
          onChange={set("assigneeMemberId")}
          error={errors.assigneeMemberId}
          hint="They see the task when they sign in and can start and finish it."
          optional
        >
          <option value="">Not a member</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · {m.memberNo}
            </option>
          ))}
        </SelectField>
        {values.assigneeMemberId ? (
          <TextField label="Due date" type="date" value={values.dueOn} onChange={set("dueOn")} error={errors.dueOn} optional />
        ) : (
          <TextField label="Or type a name" value={values.assignee} onChange={set("assignee")} error={errors.assignee} optional placeholder="Volunteer's name" />
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {!values.assigneeMemberId && (
          <TextField label="Due date" type="date" value={values.dueOn} onChange={set("dueOn")} error={errors.dueOn} optional />
        )}
        <SelectField label="Event" value={values.eventId} onChange={set("eventId")} error={errors.eventId} optional>
          <option value="">Not tied to an event</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </SelectField>
      </div>
      <TextField
        label="Volunteers needed"
        inputMode="numeric"
        value={values.volunteerSlots}
        onChange={set("volunteerSlots")}
        error={errors.volunteerSlots}
        hint={
          task && task.approvedVolunteers > 0
            ? `${task.approvedVolunteers} approved so far. 0 hides the task from members.`
            : "Leave at 0 to keep this task off the members' volunteer list. Above 0, members can ask to help and an organizer approves."
        }
        className="sm:max-w-xs"
      />
      <TextAreaField label="Notes" value={values.description} onChange={set("description")} error={errors.description} optional />
      <DialogActions>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          {task ? "Save changes" : "Add task"}
        </Button>
      </DialogActions>
    </form>
  );
}
