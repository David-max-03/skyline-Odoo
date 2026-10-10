import { taskInputSchema, taskStatusSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { deleteTask, setTaskStatus, updateTask } from "@/server/services/tasks";

/** Replace all fields of a task. */
export const PUT = staffRoute(null, { body: taskInputSchema }, ({ body, params, user }) =>
  updateTask(params.id, body, user),
);

/** Move a task between To do, In progress and Done. */
export const PATCH = staffRoute(null, { body: taskStatusSchema }, ({ body, params, user }) =>
  setTaskStatus(params.id, body.status, user),
);

export const DELETE = staffRoute(null, {}, ({ params, user }) => {
  deleteTask(params.id, user);
  return { ok: true };
});
