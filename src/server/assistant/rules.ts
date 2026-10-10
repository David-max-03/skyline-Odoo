import type { AssistantAnswer } from "@/lib/contracts";
import { matchEventInText, runTool, type ToolName } from "./tools";

/**
 * The rule-based engine. It decides which tool a question is about by keyword
 * scoring, pulls an event name and an amount out of the question when there
 * is one, and returns the tool's own summary. It is not a language model and
 * says so in the response.
 */

export const SUGGESTIONS = [
  "Which event has the most registrations?",
  "What is our current financial position?",
  "Which events are profitable?",
  "How many tickets must we sell to break even?",
  "How much more revenue do we need to reach the profit target?",
  "Which volunteer tasks are overdue?",
];

interface Intent {
  tool: ToolName;
  patterns: [RegExp, number][];
}

const INTENTS: Intent[] = [
  {
    tool: "break_even",
    patterns: [
      [/break[\s-]?even/, 6],
      [/how many (more )?tickets/, 4],
      [/cover (the |our |its )?costs?/, 4],
    ],
  },
  {
    tool: "profit_target",
    patterns: [
      [/target|goal/, 5],
      [/how much more/, 3],
      [/(reach|hit|make|earn|raise).*(profit|revenue|net)/, 3],
    ],
  },
  {
    tool: "event_profitability",
    patterns: [
      [/profitable|profitability|loss[\s-]?making/, 5],
      [/(made|make|making|lost|lose|losing) (any |a |us )?(money|profit|loss)/, 4],
      [/which events?.*(profit|loss|money)/, 3],
      [/profit|loss/, 2],
    ],
  },
  {
    tool: "event_registrations",
    patterns: [
      [/most (registrations?|sign[\s-]?ups?|registered|popular|tickets|people)/, 6],
      [/popular|best[\s-]selling/, 4],
      [/registrations?|registered|sign(ed)?[\s-]?ups?/, 3],
      [/(tickets|seats) (sold|left|remaining)/, 3],
    ],
  },
  {
    tool: "financial_position",
    patterns: [
      [/financial (position|status|health|summary|situation|standing)/, 6],
      [/balance|net income|cash position|budget/, 4],
      [/how much (money|cash)/, 4],
      [/where (did|does|has) .*money/, 4],
      [/income and expenses?|came in|went out/, 3],
      [/financ|treasur|money/, 2],
    ],
  },
  {
    tool: "overdue_tasks",
    patterns: [
      [/overdue|past due|behind schedule/, 6],
      [/(late|outstanding|pending|open) tasks?/, 4],
      [/tasks?|volunteers?|to[\s-]?dos?/, 2],
    ],
  },
  {
    tool: "outstanding_payments",
    patterns: [
      [/who (still )?owes?|owes? (us|the club)|we owe/, 6],
      [/unpaid|outstanding|not (yet )?paid|reimburs|refunds?/, 4],
      [/pending (payments?|income|expenses?)/, 4],
    ],
  },
  {
    tool: "membership_overview",
    patterns: [
      [/renew|expir|laps/, 5],
      [/how many members|member count|membership/, 4],
      [/members?|dues/, 2],
    ],
  },
  {
    tool: "attendance",
    patterns: [
      [/attendance|turnout|turn(ed)? up|show(ed)? up|no[\s-]?shows?/, 6],
      [/checked[\s-]?in|check[\s-]?ins?|attended|attendees/, 4],
    ],
  },
  {
    tool: "merch_stock",
    patterns: [
      [/stock|inventory|sold out|reorder/, 5],
      [/merch|hoodies?|t[\s-]?shirts?|sizes?/, 4],
    ],
  },
];

export function detectIntent(question: string): ToolName | null {
  const q = question.toLowerCase();
  let best: ToolName | null = null;
  let bestScore = 0;
  for (const intent of INTENTS) {
    let score = 0;
    for (const [pattern, weight] of intent.patterns) if (pattern.test(q)) score += weight;
    if (score > bestScore) {
      best = intent.tool;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Reads an amount from text like "₹25,000", "rs 25k", "1.5 lakh" or "20000".
 * Bare numbers under 100 are ignored: they are far more likely to be a count
 * of tickets or days than a profit target.
 */
export function extractAmount(question: string): number | null {
  const match = /(₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?)?\b/i.exec(question);
  if (!match) return null;
  const base = Number(match[2].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const unit = (match[3] ?? "").toLowerCase();
  const multiplier = unit.startsWith("k") || unit === "thousand" ? 1_000 : unit.startsWith("la") ? 100_000 : 1;
  const amount = base * multiplier;
  if (!match[1] && !unit && amount < 100) return null;
  return amount;
}

export const RULES_LABEL = "Rule-based engine (no language model)";

export function answerWithRules(question: string): AssistantAnswer {
  const tool = detectIntent(question);

  if (!tool) {
    const overview = runTool("financial_position");
    return {
      engine: "rules",
      engineLabel: RULES_LABEL,
      intent: "unrecognised",
      answer:
        "I could not match that to something I can calculate. I can answer questions about registrations, " +
        "attendance, finances, event profit, break-even, profit targets, overdue tasks, memberships, " +
        "outstanding payments and merchandise stock. Here is the current financial position instead. " +
        overview.summary,
      facts: overview.facts,
      sources: overview.sources,
      notice: "The question was not recognised, so a general summary is shown.",
      suggestions: SUGGESTIONS,
    };
  }

  const input: Record<string, unknown> = {};
  if (tool === "break_even" || tool === "profit_target") {
    const event = matchEventInText(question);
    if (event) input.event = event.id;
  }
  if (tool === "profit_target") {
    const amount = extractAmount(question);
    if (amount !== null) input.target_amount = amount;
    if (!input.event && /\b(club|organi[sz]ation|overall|whole|total|we|us|our)\b/i.test(question) && amount !== null) {
      // "How much more do we need to reach ₹50,000?" with no event named.
      input.scope = "organisation";
    }
  }

  const result = runTool(tool, input);
  return {
    engine: "rules",
    engineLabel: RULES_LABEL,
    intent: tool,
    answer: result.summary,
    facts: result.facts,
    sources: result.sources,
    notice: result.notice ?? null,
    suggestions: SUGGESTIONS.filter((s) => detectIntent(s) !== tool).slice(0, 4),
  };
}
