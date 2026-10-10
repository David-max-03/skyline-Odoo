import type { AssistantAnswer } from "@/lib/contracts";
import { answerWithClaude, claudeConfigured } from "./claude";
import { answerWithRules } from "./rules";

export { SUGGESTIONS } from "./rules";

export interface AssistantStatus {
  engine: "rules" | "claude";
  label: string;
}

export function assistantStatus(): AssistantStatus {
  return claudeConfigured()
    ? { engine: "claude", label: "Claude writes the answer; Skyline computes every figure." }
    : {
        engine: "rules",
        label: "Rule-based engine. No language model is connected; answers are computed from your records.",
      };
}

/**
 * Answers a staff question. Uses Claude when an API key is configured and
 * falls back to the rule-based engine on any failure, saying that it did.
 */
export async function ask(question: string): Promise<AssistantAnswer> {
  if (!claudeConfigured()) return answerWithRules(question);
  try {
    const answer = await answerWithClaude(question);
    if (answer) return answer;
    return withNotice(answerWithRules(question), "Claude did not return a grounded answer, so the rule-based engine answered.");
  } catch (error) {
    console.error("[assistant] Claude engine failed; using the rule-based engine", error);
    return withNotice(answerWithRules(question), "Claude could not be reached, so the rule-based engine answered.");
  }
}

function withNotice(answer: AssistantAnswer, notice: string): AssistantAnswer {
  return { ...answer, notice: answer.notice ? `${notice} ${answer.notice}` : notice };
}
