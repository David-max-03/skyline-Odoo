import { CATEGORY_LABELS, SETTINGS, type AssistantFact, type EventSummary } from "@/lib/contracts";
import { ORG_TZ, formatDate, formatShortDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { all } from "../db";
import { breakEvenFor, profitTargetForEvent, profitTargetForOrganisation } from "../services/analysis";
import { listEvents } from "../services/events";
import { getFinanceSummary } from "../services/finance";
import { listMembers } from "../services/members";
import { listProducts } from "../services/merch";
import { listTasks } from "../services/tasks";

/**
 * The assistant's tools: read-only functions over the club's records.
 *
 * Both engines (the rule-based one and Claude) answer through these and only
 * these. Each tool returns a plain-language summary, a list of facts tagged
 * actual / estimate / recommendation, and the records it read. All arithmetic
 * happens here or in services/analysis.ts.
 */

export interface ToolResult {
  summary: string;
  facts: AssistantFact[];
  sources: string[];
  /** An assumption or limitation the reader should know about. */
  notice?: string | null;
  data?: unknown;
}

export interface AssistantTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
  run(input: Record<string, unknown>): ToolResult;
}

const actual = (label: string, value: string): AssistantFact => ({ label, value, kind: "actual" });
const estimate = (label: string, value: string): AssistantFact => ({ label, value, kind: "estimate" });
const recommend = (label: string, value: string): AssistantFact => ({
  label,
  value,
  kind: "recommendation",
});

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const when = (iso: string) => formatShortDateTime(iso, ORG_TZ);
const noInput: AssistantTool["inputSchema"] = { type: "object", properties: {}, required: [], additionalProperties: false };

// --- finding the event a question is about --------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "night", "event", "events", "club", "skyline", "our", "this", "that",
  "how", "many", "much", "what", "which", "need", "more", "tickets", "ticket", "break", "even",
  "profit", "target", "reach", "sell", "sold", "must", "does", "will", "from", "have", "are",
]);

const tokens = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));

/** The event whose title best matches words in `text`, or null if none clearly does. */
export function matchEventInText(text: string, events: EventSummary[] = listEvents()): EventSummary | null {
  const words = new Set(tokens(text));
  let best: EventSummary | null = null;
  let bestScore = 0;
  let tie = false;
  for (const event of events) {
    const score = tokens(event.title).filter((t) => words.has(t)).length;
    if (score > bestScore) {
      best = event;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }
  return bestScore > 0 && !tie ? best : null;
}

/** Used when a question names no event: the next one coming up, else the latest. */
function defaultEvent(events: EventSummary[]): EventSummary | null {
  const upcoming = events
    .filter((e) => e.status === "published" && e.phase !== "past")
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return upcoming[0] ?? events.find((e) => e.status !== "draft") ?? events[0] ?? null;
}

function resolveEvent(ref: unknown): { event: EventSummary | null; assumed: boolean } {
  const events = listEvents();
  if (typeof ref === "string" && ref.trim()) {
    const byId = events.find((e) => e.id === ref.trim());
    if (byId) return { event: byId, assumed: false };
    const byTitle = matchEventInText(ref, events);
    if (byTitle) return { event: byTitle, assumed: false };
  }
  return { event: defaultEvent(events), assumed: true };
}

const NO_EVENTS: ToolResult = {
  summary: "There are no events yet, so there is nothing to analyse.",
  facts: [recommend("Next step", "Create and publish an event to start collecting registrations.")],
  sources: ["events"],
};

// --- tools ----------------------------------------------------------------------

const eventRegistrations: AssistantTool = {
  name: "event_registrations",
  description:
    "Registrations per event: tickets registered, capacity, seats left and how full each event is, ranked from most to fewest registrations. Use for 'which event has the most registrations', 'most popular event', 'how many signed up'.",
  inputSchema: noInput,
  run() {
    const events = listEvents()
      .filter((e) => e.status !== "draft")
      .sort((a, b) => b.stats.registered - a.stats.registered);
    if (events.length === 0) return NO_EVENTS;
    const top = events[0];
    if (top.stats.registered === 0) {
      return {
        summary: "No one has registered for any event yet.",
        facts: events.map((e) => actual(e.title, `0 of ${e.capacity} seats`)),
        sources: ["events", "tickets"],
      };
    }
    const tied = events.filter((e) => e.stats.registered === top.stats.registered);
    const lead =
      tied.length > 1
        ? `${tied.map((e) => e.title).join(" and ")} are tied for the most registrations with ${top.stats.registered} each.`
        : `${top.title} has the most registrations: ${top.stats.registered} of ${top.capacity} seats (${pct(top.stats.registered / top.capacity)} full).`;
    const runnerUp = events[tied.length];
    return {
      summary:
        lead +
        (runnerUp ? ` Next is ${runnerUp.title} with ${runnerUp.stats.registered}.` : ""),
      facts: events.slice(0, 6).map((e) =>
        actual(
          e.title + (e.status === "cancelled" ? " (cancelled)" : ""),
          `${e.stats.registered} of ${e.capacity} seats · ${pct(e.stats.registered / e.capacity)} full · ${e.stats.remaining} left`,
        ),
      ),
      sources: ["events", "tickets"],
      data: events.map((e) => ({
        id: e.id,
        title: e.title,
        status: e.status,
        startsAt: e.startsAt,
        registered: e.stats.registered,
        capacity: e.capacity,
        remaining: e.stats.remaining,
      })),
    };
  },
};

const financialPosition: AssistantTool = {
  name: "financial_position",
  description:
    "The club's overall financial position: income collected, expenses paid, net balance, amounts still to collect and still owed, the projected net if all pending items settle, and the largest income and expense categories. Use for 'financial position', 'how much money do we have', 'balance', 'where did the money go'.",
  inputSchema: noInput,
  run() {
    const s = getFinanceSummary();
    if (s.transactionCount === 0) {
      return {
        summary: "No income or expenses have been recorded yet.",
        facts: [recommend("Next step", "Record the opening balance and any dues collected so far.")],
        sources: ["transactions"],
      };
    }
    const topOf = (type: "income" | "expense") =>
      s.byCategory
        .filter((c) => c.type === type && c.settledCents > 0)
        .sort((a, b) => b.settledCents - a.settledCents)
        .slice(0, 3);
    const facts: AssistantFact[] = [
      actual("Income collected", formatMoney(s.incomeSettledCents)),
      actual("Expenses paid", formatMoney(s.expenseSettledCents)),
      actual("Net (cash position)", formatMoney(s.netCents)),
      actual("Still to collect", formatMoney(s.incomePendingCents)),
      actual("Still owed", formatMoney(s.expensePendingCents)),
      estimate("Net if all pending items settle", formatMoney(s.projectedNetCents)),
      ...topOf("income").map((c) => actual(`Income · ${CATEGORY_LABELS[c.category]}`, formatMoney(c.settledCents))),
      ...topOf("expense").map((c) => actual(`Spent · ${CATEGORY_LABELS[c.category]}`, formatMoney(c.settledCents))),
    ];
    if (s.expensePendingCents > 0) {
      facts.push(
        recommend(
          "Suggested action",
          `Settle the ${formatMoney(s.expensePendingCents)} owed to volunteers and suppliers so the books match the bank.`,
        ),
      );
    }
    return {
      summary:
        `The club has collected ${formatMoney(s.incomeSettledCents)} and paid out ${formatMoney(s.expenseSettledCents)}, ` +
        `so the net position is ${formatMoney(s.netCents)}. ` +
        `A further ${formatMoney(s.incomePendingCents)} is still to be collected and ${formatMoney(s.expensePendingCents)} is still owed. ` +
        `If every pending item settles as recorded, the net would be ${formatMoney(s.projectedNetCents)}.`,
      facts,
      sources: [`transactions (${s.transactionCount} entries)`],
      data: s,
    };
  },
};

const eventProfitability: AssistantTool = {
  name: "event_profitability",
  description:
    "Profit or loss for every event, using only money actually collected and paid (actual), plus the projected result if pending items settle (estimate). Use for 'which events are profitable', 'did the gala make money', 'event performance'.",
  inputSchema: noInput,
  run() {
    const events = listEvents().filter((e) => e.status !== "draft");
    if (events.length === 0) return NO_EVENTS;
    const withMoney = events.filter(
      (e) =>
        e.finance.incomeSettledCents + e.finance.incomePendingCents +
          e.finance.expenseSettledCents + e.finance.expensePendingCents > 0,
    );
    if (withMoney.length === 0) {
      return {
        summary: "No income or expenses are linked to any event yet, so none can be called profitable or not.",
        facts: [recommend("Next step", "Link ticket income and event costs to their event when recording them.")],
        sources: ["events", "transactions"],
      };
    }
    const ranked = [...withMoney].sort((a, b) => b.finance.netCents - a.finance.netCents);
    const profitable = ranked.filter((e) => e.finance.netCents > 0);
    const losing = ranked.filter((e) => e.finance.netCents < 0);
    const list = (items: EventSummary[]) =>
      items.map((e) => `${e.title} (${formatMoney(e.finance.netCents, { signed: true })})`).join(", ");
    let summary = `${profitable.length} of ${plural(withMoney.length, "event")} with recorded money ${profitable.length === 1 ? "is" : "are"} profitable on what has actually been collected and paid.`;
    if (profitable.length) summary += ` Profitable: ${list(profitable)}.`;
    if (losing.length) summary += ` Running at a loss: ${list(losing)}.`;
    const facts: AssistantFact[] = [];
    for (const e of ranked) {
      facts.push(
        actual(
          e.title,
          `${formatMoney(e.finance.netCents, { signed: true })} (collected ${formatMoney(e.finance.incomeSettledCents)}, paid ${formatMoney(e.finance.expenseSettledCents)})`,
        ),
      );
      if (e.finance.projectedNetCents !== e.finance.netCents) {
        facts.push(
          estimate(
            `${e.title} · if pending items settle`,
            formatMoney(e.finance.projectedNetCents, { signed: true }),
          ),
        );
      }
    }
    return {
      summary,
      facts,
      sources: ["events", "transactions linked to events"],
      data: ranked.map((e) => ({ id: e.id, title: e.title, ...e.finance })),
    };
  },
};

const breakEvenTool: AssistantTool = {
  name: "break_even",
  description:
    "How many tickets an event must sell to cover its costs. Returns total cost, non-ticket income, and tickets needed at the standard price, member price and average price paid so far. Use for 'how many tickets to break even'. Pass the event's title or id; if omitted the next upcoming event is used.",
  inputSchema: {
    type: "object",
    properties: { event: { type: "string", description: "Event title or id. Optional." } },
    required: [],
    additionalProperties: false,
  },
  run(input) {
    const { event, assumed } = resolveEvent(input.event);
    if (!event) return NO_EVENTS;
    const b = breakEvenFor(event);
    const notice = assumed ? `No event was named, so this uses the next one: ${event.title}.` : null;
    const base: AssistantFact[] = [
      actual("Costs recorded (paid and owed)", formatMoney(b.costCents)),
      actual("Other income (sponsorship, donations)", formatMoney(b.otherIncomeCents)),
      actual("Ticket income recorded (paid and pending)", formatMoney(b.ticketIncomeCents)),
      actual("Tickets registered", `${b.ticketsRegistered} of ${b.capacity}`),
    ];
    const sources = [`event: ${event.title}`, "transactions linked to this event", "tickets"];

    if (b.costCents === 0) {
      return {
        summary: `${event.title} has no costs recorded yet, so there is nothing to break even on.`,
        facts: [...base, recommend("Next step", "Record the event's expected costs to get a break-even figure.")],
        sources,
        notice,
        data: b,
      };
    }
    if (b.toCoverCents === 0) {
      return {
        summary: `${event.title} already breaks even without ticket sales: other income of ${formatMoney(b.otherIncomeCents)} covers its ${formatMoney(b.costCents)} of costs.`,
        facts: base,
        sources,
        notice,
        data: b,
      };
    }
    if (b.scenarios.length === 0) {
      return {
        summary: `${event.title} is free to attend, so ticket sales cannot cover its costs. ${formatMoney(b.toCoverCents)} must come from sponsorship, fundraising or the club budget.`,
        facts: [...base, estimate("Shortfall to fund another way", formatMoney(b.toCoverCents))],
        sources,
        notice,
        data: b,
      };
    }
    const main = b.scenarios[0];
    const facts = [
      ...base,
      ...b.scenarios.map((s) =>
        estimate(
          `${s.label} (${formatMoney(s.priceCents)})`,
          `${plural(s.ticketsNeeded, "ticket")} in total · ${s.moreTicketsNeeded} more to sell${s.achievable ? "" : " · exceeds seats left"}`,
        ),
      ),
    ];
    let summary: string;
    if (b.alreadyCovered) {
      summary = `${event.title} has already broken even on recorded ticket income: ${formatMoney(b.ticketIncomeCents)} against ${formatMoney(b.toCoverCents)} to cover. This counts tickets that are registered but not yet paid.`;
    } else {
      summary =
        `${event.title} needs ${plural(main.ticketsNeeded, "ticket")} at the standard price of ${formatMoney(main.priceCents)} to break even. ` +
        `That covers ${formatMoney(b.toCoverCents)}: costs of ${formatMoney(b.costCents)}` +
        (b.otherIncomeCents > 0 ? ` less ${formatMoney(b.otherIncomeCents)} of other income. ` : ". ") +
        `With ${formatMoney(b.ticketIncomeCents)} of ticket income already recorded, ${plural(main.moreTicketsNeeded, "more ticket")} would do it.`;
      if (!main.achievable) {
        summary += ` Only ${event.stats.remaining} seats are left, so ticket sales alone cannot close the gap.`;
        facts.push(
          recommend("Suggested action", "Reduce costs, find a sponsor, or raise capacity; the remaining seats are not enough."),
        );
      }
    }
    return { summary, facts, sources, notice, data: b };
  },
};

const profitTargetTool: AssistantTool = {
  name: "profit_target",
  description:
    "How much more revenue is needed to reach a profit target, for one event or for the whole organisation. Returns the target, actual net, projected net, the gap on each, and for events the extra standard-price tickets that would close the gap. Pass target_amount in major currency units (rupees) when the question states one; otherwise the event's stored target is used. Pass scope 'organisation' for club-wide questions.",
  inputSchema: {
    type: "object",
    properties: {
      event: { type: "string", description: "Event title or id. Optional." },
      target_amount: { type: "number", description: "Profit target in major currency units. Optional." },
      scope: { type: "string", description: "'event' (default) or 'organisation'." },
    },
    required: [],
    additionalProperties: false,
  },
  run(input) {
    const targetCents =
      typeof input.target_amount === "number" && Number.isFinite(input.target_amount) && input.target_amount > 0
        ? Math.round(input.target_amount * 100)
        : null;

    if (input.scope === "organisation") {
      if (targetCents === null) {
        return {
          summary: "To work out the gap for the whole organisation, include a target amount in the question.",
          facts: [],
          sources: [],
          notice: "No target amount was given.",
        };
      }
      const t = profitTargetForOrganisation(targetCents);
      return {
        summary:
          t.gapActualCents === 0
            ? `The club has already reached a net of ${formatMoney(t.targetCents)}: it currently stands at ${formatMoney(t.actualNetCents)}.`
            : `The club needs ${formatMoney(t.gapActualCents)} more to reach a net of ${formatMoney(t.targetCents)}. It currently stands at ${formatMoney(t.actualNetCents)}. If all pending items settle the gap would be ${formatMoney(t.gapProjectedCents)}.`,
        facts: [
          actual("Target", formatMoney(t.targetCents)),
          actual("Net today", formatMoney(t.actualNetCents)),
          actual("Still needed today", formatMoney(t.gapActualCents)),
          estimate("Net if pending items settle", formatMoney(t.projectedNetCents)),
          estimate("Still needed after pending items settle", formatMoney(t.gapProjectedCents)),
        ],
        sources: ["transactions"],
        data: t,
      };
    }

    const { event, assumed } = resolveEvent(input.event);
    if (!event) return NO_EVENTS;
    const notice = assumed ? `No event was named, so this uses the next one: ${event.title}.` : null;
    if (targetCents === null && event.profitTargetCents === null) {
      return {
        summary: `${event.title} has no profit target set. Add one on the event page, or include an amount in the question.`,
        facts: [
          actual("Net today", formatMoney(event.finance.netCents)),
          estimate("Net if pending items settle", formatMoney(event.finance.projectedNetCents)),
        ],
        sources: [`event: ${event.title}`, "transactions linked to this event"],
        notice,
      };
    }
    const t = profitTargetForEvent(event, targetCents);
    const facts: AssistantFact[] = [
      actual(targetCents === null ? "Profit target (set on the event)" : "Profit target (from the question)", formatMoney(t.targetCents)),
      actual("Net today (collected − paid)", formatMoney(t.actualNetCents, { signed: true })),
      actual("Still needed today", formatMoney(t.gapActualCents)),
      estimate("Net if pending items settle", formatMoney(t.projectedNetCents, { signed: true })),
      estimate("Still needed after pending items settle", formatMoney(t.gapProjectedCents)),
    ];
    let summary: string;
    if (t.gapActualCents === 0) {
      summary = `${event.title} has already reached its profit target of ${formatMoney(t.targetCents)}: the net is ${formatMoney(t.actualNetCents)} on money actually collected and paid.`;
    } else {
      summary =
        `${event.title} needs ${formatMoney(t.gapActualCents)} more to reach its profit target of ${formatMoney(t.targetCents)}. ` +
        `Its net today is ${formatMoney(t.actualNetCents, { signed: true })}. `;
      if (t.gapProjectedCents === 0) {
        summary += "If every pending payment and expense settles as recorded, the target is met.";
      } else {
        summary += `Even if every pending item settles, ${formatMoney(t.gapProjectedCents)} of new revenue is still needed`;
        if (t.ticketsToCloseGap !== null) {
          const fits = t.seatsRemaining !== null && t.ticketsToCloseGap <= t.seatsRemaining;
          summary += `, which is ${plural(t.ticketsToCloseGap, "more ticket")} at ${formatMoney(event.priceCents)}`;
          summary += fits ? "." : `. Only ${t.seatsRemaining} seats are left, so tickets alone will not get there.`;
          facts.push(
            estimate(
              `Extra tickets at ${formatMoney(event.priceCents)}`,
              `${t.ticketsToCloseGap} needed · ${t.seatsRemaining} seats left`,
            ),
          );
          if (!fits) {
            facts.push(recommend("Suggested action", "Look for sponsorship or cut a cost; remaining seats cannot cover the gap."));
          }
        } else {
          summary += ".";
        }
      }
    }
    return {
      summary,
      facts,
      sources: [`event: ${event.title}`, "transactions linked to this event", "tickets"],
      notice,
      data: t,
    };
  },
};

const overdueTasks: AssistantTool = {
  name: "overdue_tasks",
  description:
    "Volunteer tasks that are past their due date and not done, with assignee, due date, days overdue and linked event. Also returns counts of open and completed tasks.",
  inputSchema: noInput,
  run() {
    const tasks = listTasks();
    const overdue = tasks.filter((t) => t.isOverdue).sort((a, b) => b.daysOverdue - a.daysOverdue);
    const open = tasks.filter((t) => t.status !== "done").length;
    if (overdue.length === 0) {
      return {
        summary:
          tasks.length === 0
            ? "No volunteer tasks have been created yet."
            : `No volunteer tasks are overdue. ${plural(open, "task")} ${open === 1 ? "is" : "are"} still open.`,
        facts: [actual("Open tasks", String(open)), actual("Overdue tasks", "0")],
        sources: ["tasks"],
      };
    }
    return {
      summary:
        `${plural(overdue.length, "volunteer task")} ${overdue.length === 1 ? "is" : "are"} overdue: ` +
        overdue
          .map((t) => `${t.title} (${t.assignee ?? "unassigned"}, ${plural(t.daysOverdue, "day")} late)`)
          .join("; ") +
        ".",
      facts: [
        ...overdue.map((t) =>
          actual(
            t.title,
            `${t.assignee ?? "Unassigned"} · due ${formatDate(t.dueOn)} · ${plural(t.daysOverdue, "day")} overdue${t.eventTitle ? ` · ${t.eventTitle}` : ""}`,
          ),
        ),
        ...(overdue.some((t) => !t.assignee)
          ? [recommend("Suggested action", "Assign an owner to the unassigned overdue tasks first.")]
          : []),
      ],
      sources: [`tasks (${tasks.length} total, ${open} open)`],
      data: overdue,
    };
  },
};

const membershipOverview: AssistantTool = {
  name: "membership_overview",
  description:
    "Membership numbers: total, active, ending soon, lapsed and unpaid, with the members whose term ends soon and the dues still owed.",
  inputSchema: noInput,
  run() {
    const members = listMembers();
    if (members.length === 0) {
      return { summary: "No members have been registered yet.", facts: [], sources: ["members"] };
    }
    const by = (s: string) => members.filter((m) => m.status === s);
    const expiring = by("expiring").sort((a, b) => (a.daysToExpiry ?? 0) - (b.daysToExpiry ?? 0));
    const owed = members.reduce((sum, m) => sum + m.duesOwedCents, 0);
    const active = by("active").length + expiring.length;
    const facts: AssistantFact[] = [
      actual("Members on the list", String(members.length)),
      actual("Active (dues paid, term current)", String(active)),
      actual(`Term ends within ${SETTINGS.renewalReminderDays} days`, String(expiring.length)),
      actual("Lapsed", String(by("lapsed").length)),
      actual("Signed up, dues not collected", String(by("unpaid").length)),
      actual("Dues still owed", formatMoney(owed)),
      ...expiring
        .slice(0, 8)
        .map((m) => actual(`Renewal due · ${m.name}`, `${m.memberNo} · ends ${formatDate(m.paidUntilOn)} (${plural(m.daysToExpiry ?? 0, "day")})`)),
    ];
    if (expiring.length > 0) {
      facts.push(recommend("Suggested action", `Remind the ${plural(expiring.length, "member")} whose term is ending to renew.`));
    }
    return {
      summary:
        `The club has ${plural(members.length, "member")} on its list; ${active} ${active === 1 ? "is" : "are"} active. ` +
        `${plural(expiring.length, "membership")} ${expiring.length === 1 ? "ends" : "end"} within ${SETTINGS.renewalReminderDays} days, ` +
        `${by("lapsed").length} ${by("lapsed").length === 1 ? "has" : "have"} lapsed, and ${by("unpaid").length} signed up without paying dues (${formatMoney(owed)} owed).`,
      facts,
      sources: ["members", "membership terms"],
    };
  },
};

const outstandingPayments: AssistantTool = {
  name: "outstanding_payments",
  description:
    "Who still owes the club money and whom the club still owes: pending ticket payments, unpaid dues, unpaid merchandise orders, expense claims waiting to be reimbursed and refunds due.",
  inputSchema: noInput,
  run() {
    const rows = all<{
      type: "income" | "expense";
      category: keyof typeof CATEGORY_LABELS;
      n: number;
      total: number;
    }>(
      `SELECT type, category, COUNT(*) AS n, SUM(amount_cents) AS total FROM transactions
       WHERE voided_at IS NULL AND status = 'pending' GROUP BY type, category ORDER BY total DESC`,
    );
    if (rows.length === 0) {
      return {
        summary: "Nothing is outstanding. Every recorded amount has been collected or paid.",
        facts: [actual("Pending entries", "0")],
        sources: ["transactions"],
      };
    }
    const sum = (type: string) => rows.filter((r) => r.type === type).reduce((s, r) => s + r.total, 0);
    const claimants = all<{ counterparty: string | null; total: number }>(
      `SELECT counterparty, SUM(amount_cents) AS total FROM transactions
       WHERE voided_at IS NULL AND status = 'pending' AND type = 'expense'
       GROUP BY counterparty ORDER BY total DESC LIMIT 5`,
    );
    return {
      summary:
        `${formatMoney(sum("income"))} is still to be collected and ${formatMoney(sum("expense"))} is still owed by the club.`,
      facts: [
        ...rows.map((r) =>
          actual(
            `${r.type === "income" ? "To collect" : "To pay"} · ${CATEGORY_LABELS[r.category] ?? r.category}`,
            `${formatMoney(r.total)} across ${plural(r.n, "entry", "entries")}`,
          ),
        ),
        ...claimants.map((c) => actual(`Owed to ${c.counterparty ?? "unnamed payee"}`, formatMoney(c.total))),
      ],
      sources: ["transactions with status pending"],
      data: rows,
    };
  },
};

const attendance: AssistantTool = {
  name: "attendance",
  description:
    "Attendance per event that has started: people checked in versus registered, and the turnout rate. Use for 'how many people showed up', 'turnout', 'attendance'.",
  inputSchema: noInput,
  run() {
    const started = listEvents().filter((e) => e.status === "published" && e.phase !== "upcoming");
    if (started.length === 0) {
      return {
        summary: "No published event has started yet, so there is no attendance to report.",
        facts: [],
        sources: ["events", "tickets"],
      };
    }
    const registered = started.reduce((s, e) => s + e.stats.registered, 0);
    const checkedIn = started.reduce((s, e) => s + e.stats.checkedIn, 0);
    return {
      summary:
        `Across ${plural(started.length, "event")} that ${started.length === 1 ? "has" : "have"} started, ${checkedIn} of ${registered} registered people were checked in` +
        (registered > 0 ? ` (${pct(checkedIn / registered)} turnout).` : "."),
      facts: started.map((e) =>
        actual(
          `${e.title} · ${when(e.startsAt)}`,
          `${e.stats.checkedIn} of ${e.stats.registered} checked in${e.stats.attendanceRate === null ? "" : ` (${pct(e.stats.attendanceRate)})`}`,
        ),
      ),
      sources: ["tickets (check-in records)"],
    };
  },
};

const merchStock: AssistantTool = {
  name: "merch_stock",
  description:
    "Merchandise stock by product and size, units sold, and sizes that are low or sold out.",
  inputSchema: noInput,
  run() {
    const products = listProducts();
    if (products.length === 0) {
      return { summary: "No merchandise has been added yet.", facts: [], sources: ["products"] };
    }
    const low = products.flatMap((p) =>
      p.active
        ? p.variants
            .filter((v) => v.stock <= SETTINGS.lowStockThreshold)
            .map((v) => ({ product: p.name, size: v.size, stock: v.stock }))
        : [],
    );
    const facts: AssistantFact[] = products.map((p) =>
      actual(
        p.name + (p.active ? "" : " (not on sale)"),
        `${p.totalStock} in stock · ${p.unitsSold} sold · ${p.variants.map((v) => `${v.size}: ${v.stock}`).join(", ")}`,
      ),
    );
    if (low.length > 0) {
      facts.push(
        recommend("Suggested action", `Reorder ${low.map((l) => `${l.product} ${l.size}`).join(", ")}.`),
      );
    }
    return {
      summary:
        low.length === 0
          ? "All merchandise sizes are above the low-stock level."
          : `${plural(low.length, "size")} ${low.length === 1 ? "is" : "are"} low or sold out: ` +
            low.map((l) => `${l.product} ${l.size} (${l.stock === 0 ? "sold out" : `${l.stock} left`})`).join(", ") +
            ".",
      facts,
      sources: ["products", "orders"],
    };
  },
};

export const TOOLS: AssistantTool[] = [
  eventRegistrations,
  financialPosition,
  eventProfitability,
  breakEvenTool,
  profitTargetTool,
  overdueTasks,
  membershipOverview,
  outstandingPayments,
  attendance,
  merchStock,
];

export type ToolName =
  | "event_registrations"
  | "financial_position"
  | "event_profitability"
  | "break_even"
  | "profit_target"
  | "overdue_tasks"
  | "membership_overview"
  | "outstanding_payments"
  | "attendance"
  | "merch_stock";

export function runTool(name: string, input: Record<string, unknown> = {}): ToolResult {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown assistant tool: ${name}`);
  return tool.run(input);
}
