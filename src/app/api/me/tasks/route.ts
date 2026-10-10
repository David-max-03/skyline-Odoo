import { memberRoute } from "@/server/http";
import { listMemberTasks } from "@/server/services/tasks";

/** The tasks assigned to the signed-in member. */
export const GET = memberRoute({}, ({ memberId }) => listMemberTasks(memberId));
