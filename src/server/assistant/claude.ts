import Anthropic from "@anthropic-ai/sdk";
import type { AssistantAnswer, AssistantFact } from "@/lib/contracts";
import { ORG_TZ, ymdInTz } from "@/lib/dates";
import { CURRENCY } from "@/lib/money";
import { SUGGESTIONS } from "./rules";
import { TOOLS, runTool } from "./tools";

/**
 * Optional Claude engine, used only when ANTHROPIC_API_KEY is set.
 *
 * Claude chooses which read-only tools to call and writes the wording. It is
 * never given database access and is told not to calculate: every figure it
 * can quote comes from a tool result. The facts shown beside the answer are
 * taken straight from those tool results, not from the model's text.
 */

const MODEL = process.env.SKYLINE_ASSISTANT_MODEL || "claude-opus-5-5";
const MAX_TURNS = 5;

export function claudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const SYSTEM = `You are the assistant inside Skyline, the management system of a student organisation. Committee members ask you about the club's events, money, members, volunteers and merchandise.

How to answer:
- Call the tools to get the club's records. Every number, name and date in your answer must come from a tool result in this conversation. If the tools do not cover a question, say so plainly instead of guessing.
- Do not do arithmetic yourself. The tools already return totals, gaps, percentages and ticket counts; quote those. If a figure you would need is not in a tool result, say it is not available.
- Tool results tag each fact as "actual" (read from stored records), "estimate" (calculated with a stated assumption, such as pending payments settling) or "recommendation". Keep that distinction clear in your wording: never present an estimate as something that has happened.
- If a tool result includes a "notice", pass that caveat on.
- Answer in two to five plain sentences. Lead with the direct answer. No headings, bullet lists, tables or markdown; a panel beside your answer already lists the individual facts.
- Amounts are in ${CURRENCY}. Repeat amounts exactly as the tools format them.`;

const tools: Anthropic.Tool[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

/** Returns null when Claude cannot produce a grounded answer, so the caller can fall back. */
export async function answerWithClaude(question: string): Promise<AssistantAnswer | null> {
  const client = new Anthropic({ timeout: 45_000, maxRetries: 1 });
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Today is ${ymdInTz(new Date())} (${ORG_TZ}).\n\nQuestion: ${question}`,
    },
  ];

  const facts: AssistantFact[] = [];
  const sources = new Set<string>();
  const notices: string[] = [];
  const called: string[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      tools,
      output_config: { effort: "low" },
      messages,
    });

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        try {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const result = runTool(block.name, input);
          called.push(block.name);
          for (const fact of result.facts) {
            if (!facts.some((f) => f.label === fact.label && f.value === fact.value)) facts.push(fact);
          }
          result.sources.forEach((s) => sources.add(s));
          if (result.notice) notices.push(result.notice);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({
              summary: result.summary,
              facts: result.facts,
              notice: result.notice ?? null,
              data: result.data ?? null,
            }),
          });
        } catch (error) {
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: error instanceof Error ? error.message : "The tool failed.",
          });
        }
      }
      // All results for one assistant turn go back in a single user message.
      messages.push({ role: "user", content: results });
      continue;
    }

    if (response.stop_reason !== "end_turn") return null; // refusal, max_tokens, pause_turn…

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    // An answer that used no tool has no records behind it. Do not show it.
    if (!text || called.length === 0) return null;

    return {
      engine: "claude",
      engineLabel: `Claude (${MODEL}) reading tool results; figures computed by Skyline`,
      intent: called.join(", "),
      answer: text,
      facts,
      sources: [...sources],
      notice: notices.length ? notices.join(" ") : null,
      suggestions: SUGGESTIONS.slice(0, 4),
    };
  }
  return null;
}
