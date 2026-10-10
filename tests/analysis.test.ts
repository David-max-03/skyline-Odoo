import { beforeEach, describe, expect, it } from "vitest";
import { transactionInputSchema, type TransactionInput } from "@/lib/contracts";
import { today } from "@/server/db";
import { breakEven, profitTargetForEvent, ticketsFor } from "@/server/services/analysis";
import { getEvent } from "@/server/services/events";
import { createTransaction } from "@/server/services/finance";
import { registerForEvent } from "@/server/services/tickets";
import { freshDb, person, publishedEvent, type Staff } from "./helpers";

let staff: Staff;
beforeEach(async () => {
  staff = await freshDb();
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
async function scenario() {
  const gala = await publishedEvent(staff, { title: "Winter Gala", capacity: 40, priceCents: 50000, memberPriceCents: 50000, profitTargetCents: 500000 });
  const mixer = await publishedEvent(staff, { title: "Freshers Mixer", capacity: 30, priceCents: 10000, memberPriceCents: 10000 });
  for (let i = 1; i <= 3; i++) await registerForEvent(gala.id, person(i), { actor: staff.organizer, payNow: "upi" });
  await registerForEvent(gala.id, person(4));
  for (let i = 1; i <= 2; i++) await registerForEvent(mixer.id, person(i), { actor: staff.organizer, payNow: "cash" });
  await record({ category: "venue", amountCents: 600000, eventId: gala.id });
  await record({ category: "catering", amountCents: 400000, status: "pending", eventId: gala.id });
  await record({ type: "income", category: "sponsorship", amountCents: 200000, eventId: gala.id });
  return { gala, mixer };
}

describe("deterministic analysis", () => {
  it("rounds ticket counts up", () => {
    expect(ticketsFor(0, 500)).toBe(0);
    expect(ticketsFor(1, 500)).toBe(1);
    expect(ticketsFor(1000, 500)).toBe(2);
    expect(ticketsFor(1001, 500)).toBe(3);
  });

  it("computes break-even from costs, other income and tickets", async () => {
    const { gala, mixer } = await scenario();
    const b = await breakEven(gala.id);
    expect(b.costCents).toBe(1000000);
    expect(b.otherIncomeCents).toBe(200000);
    expect(b.toCoverCents).toBe(800000);
    expect(b.ticketIncomeCents).toBe(200000); // 3 paid + 1 pending
    expect(b.alreadyCovered).toBe(false);
    expect(b.scenarios).toHaveLength(1); // member price and average both equal the standard price
    expect(b.scenarios[0]).toMatchObject({ priceCents: 50000, ticketsNeeded: 16, moreTicketsNeeded: 12, achievable: true });

    const none = await breakEven(mixer.id);
    expect(none.costCents).toBe(0);
    expect(none.alreadyCovered).toBe(true);
  });

  it("computes the gap to a profit target on actual and projected figures", async () => {
    const { gala } = await scenario();
    const t = profitTargetForEvent(await getEvent(gala.id));
    expect(t.actualNetCents).toBe(150000 + 200000 - 600000); // −2,500
    expect(t.projectedNetCents).toBe(200000 + 200000 - 1000000); // −6,000
    expect(t.gapActualCents).toBe(750000);
    expect(t.gapProjectedCents).toBe(1100000);
    expect(t.ticketsToCloseGap).toBe(22);
    expect(t.seatsRemaining).toBe(36);
    expect(profitTargetForEvent(await getEvent(gala.id), 100000).gapProjectedCents).toBe(700000);
  });
});
