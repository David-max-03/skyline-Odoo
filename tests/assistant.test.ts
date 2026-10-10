import { beforeEach, describe, expect, it } from "vitest";
import { taskInputSchema, transactionInputSchema, type TransactionInput } from "@/lib/contracts";
import { addDays } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { today } from "@/server/db";
import { ask, assistantStatus } from "@/server/assistant";
import { answerWithRules, detectIntent, extractAmount } from "@/server/assistant/rules";
import { matchEventInText } from "@/server/assistant/tools";
import { breakEven, profitTargetForEvent, ticketsFor } from "@/server/services/analysis";
import { getEvent } from "@/server/services/events";
import { createTransaction, getFinanceTotals } from "@/server/services/finance";
import { createTask } from "@/server/services/tasks";
import { registerForEvent } from "@/server/services/tickets";
import { freshDb, person, publishedEvent, type Staff } from "./helpers";

let staff: Staff;
beforeEach(() => {
  staff = freshDb();
});

const record = (overrides: Partial<TransactionInput>) =>
  createTransaction(
    transactionInputSchema.parse({
      type: "expense",
      category: "venue",
      amountCents: 100000,
      status: "settled",
      occurredOn: today(),
      description: "Test entry",
      ...overrides,
    }),
    staff.treasurer,
  );

/**
 * Gala: ₹500 tickets, 40 seats, target ₹5,000. Costs ₹10,000 (6,000 paid,
 * 4,000 owed), sponsorship ₹2,000, 3 tickets paid and 1 unpaid.
 * Mixer: ₹100 tickets, 2 paid, no costs.
 */
function scenario() {
  const gala = publishedEvent(staff, { title: "Winter Gala", capacity: 40, priceCents: 50000, memberPriceCents: 50000, profitTargetCents: 500000 });
  const mixer = publishedEvent(staff, { title: "Freshers Mixer", capacity: 30, priceCents: 10000, memberPriceCents: 10000 });
  for (let i = 1; i <= 3; i++) registerForEvent(gala.id, person(i), { actor: staff.organizer, payNow: "upi" });
  registerForEvent(gala.id, person(4));
  for (let i = 1; i <= 2; i++) registerForEvent(mixer.id, person(i), { actor: staff.organizer, payNow: "cash" });
  record({ category: "venue", amountCents: 600000, eventId: gala.id });
  record({ category: "catering", amountCents: 400000, status: "pending", eventId: gala.id });
  record({ type: "income", category: "sponsorship", amountCents: 200000, eventId: gala.id });
  return { gala, mixer };
}

describe("deterministic analysis", () => {
  it("rounds ticket counts up", () => {
    expect(ticketsFor(0, 500)).toBe(0);
    expect(ticketsFor(1, 500)).toBe(1);
    expect(ticketsFor(1000, 500)).toBe(2);
    expect(ticketsFor(1001, 500)).toBe(3);
  });

  it("computes break-even from costs, other income and tickets", () => {
    const { gala, mixer } = scenario();
    const b = breakEven(gala.id);
    expect(b.costCents).toBe(1000000);
    expect(b.otherIncomeCents).toBe(200000);
    expect(b.toCoverCents).toBe(800000);
    expect(b.ticketIncomeCents).toBe(200000); // 3 paid + 1 pending
    expect(b.alreadyCovered).toBe(false);
    expect(b.scenarios).toHaveLength(1); // member price and average both equal the standard price
    expect(b.scenarios[0]).toMatchObject({ priceCents: 50000, ticketsNeeded: 16, moreTicketsNeeded: 12, achievable: true });

    const none = breakEven(mixer.id);
    expect(none.costCents).toBe(0);
    expect(none.alreadyCovered).toBe(true);
  });

  it("computes the gap to a profit target on actual and projected figures", () => {
    const { gala } = scenario();
    const t = profitTargetForEvent(getEvent(gala.id));
    expect(t.actualNetCents).toBe(150000 + 200000 - 600000); // −2,500
    expect(t.projectedNetCents).toBe(200000 + 200000 - 1000000); // −6,000
    expect(t.gapActualCents).toBe(750000);
    expect(t.gapProjectedCents).toBe(1100000);
    expect(t.ticketsToCloseGap).toBe(22);
    expect(t.seatsRemaining).toBe(36);
    expect(profitTargetForEvent(getEvent(gala.id), 100000).gapProjectedCents).toBe(700000);
  });
});

describe("question understanding", () => {
  it("routes the required questions to the right tool", () => {
    expect(detectIntent("Which event has the most registrations?")).toBe("event_registrations");
    expect(detectIntent("What is the current financial position?")).toBe("financial_position");
    expect(detectIntent("Which events are profitable?")).toBe("event_profitability");
    expect(detectIntent("How much more revenue is needed to reach a profit target?")).toBe("profit_target");
    expect(detectIntent("How many tickets must be sold to break even?")).toBe("break_even");
    expect(detectIntent("Which volunteer tasks are overdue?")).toBe("overdue_tasks");
    expect(detectIntent("How many people showed up?")).toBe("attendance");
    expect(detectIntent("Whose membership is about to expire?")).toBe("membership_overview");
    expect(detectIntent("Who still owes us money?")).toBe("outstanding_payments");
    expect(detectIntent("Which hoodie sizes are sold out?")).toBe("merch_stock");
    expect(detectIntent("What is the meaning of life?")).toBeNull();
  });

  it("reads amounts and event names out of a question", () => {
    expect(extractAmount("reach a profit of ₹25,000")).toBe(25000);
    expect(extractAmount("target of rs 30k")).toBe(30000);
    expect(extractAmount("we want 1.5 lakh")).toBe(150000);
    expect(extractAmount("sell 40 tickets")).toBeNull();
    expect(extractAmount("no numbers here")).toBeNull();
    const { gala, mixer } = scenario();
    expect(matchEventInText("break even for the gala?")?.id).toBe(gala.id);
    expect(matchEventInText("how is the freshers mixer doing")?.id).toBe(mixer.id);
    expect(matchEventInText("how are we doing overall")).toBeNull();
  });
});

describe("answers are grounded in the records", () => {
  it("names the event with the most registrations", () => {
    scenario();
    const a = answerWithRules("Which event has the most registrations?");
    expect(a.engine).toBe("rules");
    expect(a.answer).toContain("Winter Gala has the most registrations: 4 of 40 seats (10% full)");
    expect(a.facts[0]).toMatchObject({ label: "Winter Gala", kind: "actual" });
    expect(a.sources).toContain("tickets");
  });

  it("reports the financial position with the same totals as the ledger", () => {
    scenario();
    const totals = getFinanceTotals();
    expect(totals.incomeSettledCents).toBe(150000 + 20000 + 200000);
    const a = answerWithRules("What is our current financial position?");
    expect(a.answer).toContain(`collected ${formatMoney(totals.incomeSettledCents)}`);
    expect(a.answer).toContain(`net position is ${formatMoney(totals.netCents)}`);
    const fact = (label: string) => a.facts.find((f) => f.label === label);
    expect(fact("Net (cash position)")).toMatchObject({ value: formatMoney(totals.netCents), kind: "actual" });
    expect(fact("Still to collect")?.value).toBe(formatMoney(50000));
    expect(fact("Net if all pending items settle")).toMatchObject({ value: formatMoney(totals.projectedNetCents), kind: "estimate" });
    expect(a.facts.some((f) => f.kind === "recommendation")).toBe(true);
  });

  it("separates profitable events from loss-making ones", () => {
    scenario();
    const a = answerWithRules("Which events are profitable?");
    expect(a.answer).toContain("1 of 2 events");
    expect(a.answer).toContain("Profitable: Freshers Mixer (+₹200)");
    expect(a.answer).toContain("Running at a loss: Winter Gala (−₹2,500)");
    expect(a.facts.find((f) => f.label.includes("if pending items settle"))?.kind).toBe("estimate");
  });

  it("answers break-even for the named event and labels it an estimate", () => {
    scenario();
    const a = answerWithRules("How many tickets must we sell for the Winter Gala to break even?");
    expect(a.intent).toBe("break_even");
    expect(a.answer).toContain("needs 16 tickets at the standard price of ₹500");
    expect(a.answer).toContain("12 more tickets would do it");
    expect(a.notice).toBeNull();
    const scenarioFact = a.facts.find((f) => f.label.startsWith("At the standard price"))!;
    expect(scenarioFact.kind).toBe("estimate");
    expect(a.facts.find((f) => f.label.startsWith("Costs recorded"))).toMatchObject({ value: "₹10,000", kind: "actual" });
  });

  it("says which event it assumed when none is named", () => {
    scenario();
    const a = answerWithRules("How many tickets to break even?");
    expect(a.notice).toMatch(/No event was named/);
  });

  it("answers the profit-target gap, using a target from the question when given", () => {
    scenario();
    const stored = answerWithRules("How much more revenue does the Winter Gala need to reach its profit target?");
    expect(stored.answer).toContain("needs ₹7,500 more to reach its profit target of ₹5,000");
    expect(stored.answer).toContain("₹11,000 of new revenue is still needed, which is 22 more tickets at ₹500");
    const custom = answerWithRules("How much more does the gala need to hit a target of ₹1,000?");
    expect(custom.answer).toContain("profit target of ₹1,000");
    expect(custom.facts[0].label).toContain("from the question");
    const org = answerWithRules("How much more do we need overall to reach a goal of ₹50,000?");
    expect(org.answer).toContain(`needs ${formatMoney(5000000 - getFinanceTotals().netCents)} more`);
  });

  it("lists overdue volunteer tasks with owner and delay", () => {
    scenario();
    const task = (title: string, assignee: string | null, due: number) =>
      createTask(taskInputSchema.parse({ title, assignee, dueOn: addDays(today(), due) }), staff.organizer);
    expect(answerWithRules("Which volunteer tasks are overdue?").answer).toContain("No volunteer tasks have been created");
    task("Book DJ", "Kabir", -2);
    task("Collect logos", null, -1);
    task("Order pizza", "Dev", 3);
    const a = answerWithRules("Which volunteer tasks are overdue?");
    expect(a.answer).toContain("2 volunteer tasks are overdue");
    expect(a.answer).toContain("Book DJ (Kabir, 2 days late)");
    expect(a.answer).toContain("Collect logos (unassigned, 1 day late)");
    expect(a.answer).not.toContain("Order pizza");
  });

  it("is honest when it cannot answer or has no data", () => {
    const empty = answerWithRules("Which event has the most registrations?");
    expect(empty.answer).toContain("no events yet");
    scenario();
    const unknown = answerWithRules("What should we name the mascot?");
    expect(unknown.intent).toBe("unrecognised");
    expect(unknown.notice).toBeTruthy();
    expect(unknown.answer).toContain("could not match");
  });

  it("uses the rule-based engine, and says so, when no API key is configured", async () => {
    scenario();
    expect(assistantStatus().engine).toBe("rules");
    const a = await ask("Which events are profitable?");
    expect(a.engine).toBe("rules");
    expect(a.engineLabel).toMatch(/no language model/i);
  });
});
