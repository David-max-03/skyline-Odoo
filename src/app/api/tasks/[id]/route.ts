import { taskActionSchema, taskInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { deleteTask, transitionTask, updateTask } from "@/server/services/tasks";

/** Replace a task's details and assignment. The status is not changed here. */
export const PUT = staffRoute(null, { body: taskInputSchema }, ({ body, params, user }) =>
  updateTask(params.id, body, user),
);

/** Move a task one step: `start`, `done` or `reopen`. */
export const PATCH = staffRoute(null, { body: taskActionSchema }, ({ body, params, user }) =>
  transitionTask(params.id, body.action, user),
);

export const DELETE = staffRoute(null, {}, async ({ params, user }) => {
  await deleteTask(params.id, user);
  return { ok: true };
});
