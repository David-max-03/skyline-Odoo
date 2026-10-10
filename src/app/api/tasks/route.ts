import { taskInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { createTask, listTasks } from "@/server/services/tasks";

export const GET = staffRoute(null, {}, () => listTasks());

export const POST = staffRoute(null, { body: taskInputSchema }, ({ body, user }) => createTask(body, user));
