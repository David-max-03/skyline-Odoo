import { assistantQuestionSchema } from "@/lib/contracts";
import { SUGGESTIONS, ask, assistantStatus } from "@/server/assistant";
import { LIMITS, staffRoute } from "@/server/http";

/** Which engine is active, and starter questions. */
export const GET = staffRoute(null, {}, () => ({ ...assistantStatus(), suggestions: SUGGESTIONS }));

/** Ask a question. Staff only: answers draw on members, money and tasks. */
export const POST = staffRoute(
  null,
  { body: assistantQuestionSchema, limit: LIMITS.assistant },
  ({ body }) => ask(body.question),
);
