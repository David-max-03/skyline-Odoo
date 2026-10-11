import { CAN, taskInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { createTask, listTasks } from "@/server/services/tasks";

export const GET = staffRoute(CAN.manageTasks, {}, () => listTasks());

export const POST = staffRoute(CAN.manageTasks, { body: taskInputSchema }, ({ body, user }) => createTask(body, user));
