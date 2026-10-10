"use client";

import { ArrowRight, CalendarDays, Check, ListChecks, RotateCcw } from "lucide-react";
import { useState } from "react";
import { TaskStatusBadge } from "@/components/domain";
import { useToast } from "@/components/overlay";
import { Button, Card, EmptyState, ErrorState, LoadingBlock, PageHeader, cn } from "@/components/ui";
import { api, errorMessage, useApi } from "@/lib/api-client";
import { TASK_NEXT_ACTION, type Task } from "@/lib/contracts";
import { formatDate } from "@/lib/dates";

export default function MemberTasksPage() {
  const toast = useToast();
  const { data, error, reload } = useApi<Task[]>("/api/me/tasks");
  const [busy, setBusy] = useState<string | null>(null);

  /** Takes the one step available from the task's current status. */
  async function advance(task: Task) {
    setBusy(task.id);
    try {
      await api(`/api/me/tasks/${task.id}`, { method: "PATCH", body: { action: TASK_NEXT_ACTION[task.status].action } });
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
      reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader title="My tasks" description="Volunteer jobs the committee has given you. Press Start when you begin and Done when you finish." />
      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : !data ? (
        <Card>
          <LoadingBlock label="Loading your tasks" />
        </Card>
      ) : data.length === 0 ? (
        <Card>
          <EmptyState icon={ListChecks} title="No tasks for you right now" description="When the committee assigns you something, it shows up here." />
        </Card>
      ) : (
        <ul className="space-y-3">
          {data.map((task) => (
            <li
              key={task.id}
              className={cn(
                "flex flex-col gap-4 rounded-card border bg-surface p-5 shadow-card sm:flex-row sm:items-center sm:justify-between",
                task.isOverdue ? "border-bad/40" : "border-line",
              )}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className={cn("text-[0.9375rem] font-semibold", task.status === "done" && "!text-muted line-through")}>{task.title}</h2>
                  <TaskStatusBadge status={task.status} />
                </div>
                {task.description && <p className="mt-1 text-sm text-muted">{task.description}</p>}
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-muted">
                  {task.dueOn && (
                    <span className={cn("inline-flex items-center gap-1", task.isOverdue && "font-medium text-bad")}>
                      <CalendarDays className="size-3.5" aria-hidden />
                      {task.isOverdue ? `${task.daysOverdue} ${task.daysOverdue === 1 ? "day" : "days"} overdue` : `Due ${formatDate(task.dueOn)}`}
                    </span>
                  )}
                  {task.eventTitle && <span>{task.eventTitle}</span>}
                </p>
              </div>
              <Button
                size="lg"
                className="shrink-0 sm:w-36"
                icon={task.status === "todo" ? ArrowRight : task.status === "in_progress" ? Check : RotateCcw}
                loading={busy === task.id}
                aria-label={`${TASK_NEXT_ACTION[task.status].label}: ${task.title}`}
                onClick={() => advance(task)}
              >
                {TASK_NEXT_ACTION[task.status].label}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
