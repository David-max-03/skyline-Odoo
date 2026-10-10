import type {
  BreakEvenAnalysis,
  BreakEvenScenario,
  EventSummary,
  ProfitTargetAnalysis,
} from "@/lib/contracts";
import { AppError } from "../errors";
import { getEvent } from "./events";

/**
 * Deterministic financial analysis for the event page: break-even and the
 * gap to a profit target, computed from the event's ledger rows.
 */

/** Smallest whole number of tickets at `priceCents` that covers `amountCents`. */
export function ticketsFor(amountCents: number, priceCents: number): number {
  if (amountCents <= 0) return 0;
  return Math.ceil(amountCents / priceCents);
}

export function breakEvenFor(event: EventSummary): BreakEvenAnalysis {
  const f = event.finance;
  const costCents = f.expenseSettledCents + f.expensePendingCents;
  const ticketIncomeCents = f.ticketIncomeSettledCents + f.ticketIncomePendingCents;
  const otherIncomeCents = f.incomeSettledCents + f.incomePendingCents - ticketIncomeCents;
  const toCoverCents = Math.max(0, costCents - otherIncomeCents);
  const stillToCoverCents = Math.max(0, toCoverCents - ticketIncomeCents);
  const seatsLeft = event.stats.remaining;

  const prices: { label: string; priceCents: number }[] = [];
  if (event.priceCents > 0) {
    prices.push({ label: "At the standard price", priceCents: event.priceCents });
  }
  if (event.memberPriceCents > 0 && event.memberPriceCents !== event.priceCents) {
    prices.push({ label: "At the member price", priceCents: event.memberPriceCents });
  }
  const payingTickets = event.stats.paid + event.stats.pending;
  if (payingTickets > 0 && ticketIncomeCents > 0) {
    const average = Math.round(ticketIncomeCents / payingTickets);
    if (average > 0 && !prices.some((p) => p.priceCents === average)) {
      prices.push({ label: "At the average price paid so far", priceCents: average });
    }
  }

  const scenarios: BreakEvenScenario[] = prices.map((p) => {
    const moreTicketsNeeded = ticketsFor(stillToCoverCents, p.priceCents);
    return {
      label: p.label,
      priceCents: p.priceCents,
      ticketsNeeded: ticketsFor(toCoverCents, p.priceCents),
      moreTicketsNeeded,
      achievable: moreTicketsNeeded <= seatsLeft,
    };
  });

  return {
    eventId: event.id,
    title: event.title,
    costCents,
    otherIncomeCents,
    toCoverCents,
    ticketIncomeCents,
    ticketsRegistered: event.stats.registered,
    capacity: event.capacity,
    alreadyCovered: stillToCoverCents === 0,
    scenarios,
  };
}

export async function breakEven(eventId: string): Promise<BreakEvenAnalysis> {
  return breakEvenFor(await getEvent(eventId));
}

export function profitTargetForEvent(event: EventSummary, targetCents?: number | null): ProfitTargetAnalysis {
  const target = targetCents ?? event.profitTargetCents;
  if (target === null || target === undefined) {
    throw new AppError(
      "no_target",
      `${event.title} has no profit target. Set one on the event.`,
      422,
    );
  }
  const gapProjectedCents = Math.max(0, target - event.finance.projectedNetCents);
  return {
    scope: "event",
    eventId: event.id,
    title: event.title,
    targetCents: target,
    actualNetCents: event.finance.netCents,
    projectedNetCents: event.finance.projectedNetCents,
    gapActualCents: Math.max(0, target - event.finance.netCents),
    gapProjectedCents,
    ticketsToCloseGap: event.priceCents > 0 ? ticketsFor(gapProjectedCents, event.priceCents) : null,
    seatsRemaining: event.stats.remaining,
  };
}
