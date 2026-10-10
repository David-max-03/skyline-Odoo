import { taskActionSchema } from "@/lib/contracts";
import { memberRoute } from "@/server/http";
import { transitionTask } from "@/server/services/tasks";

/**
 * Move one of the member's own tasks a step: `start`, `done` or `reopen`.
 * The body carries nothing but the action, so a member cannot reassign,
 * rename or reschedule a task through this route.
 */
export const PATCH = memberRoute({ body: taskActionSchema }, ({ body, params, user }) =>
  transitionTask(params.id, body.action, user),
);
