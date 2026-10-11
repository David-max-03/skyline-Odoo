import {
  CAN,
  ROLES,
  can,
  type DashboardAlert,
  type DashboardView,
  type EventDetailView,
  type EventSummary,
  type EventView,
  type FinanceSummary,
  type Member,
  type MemberDetail,
  type Order,
  type SessionUser,
  type Transaction,
} from "@/lib/contracts";
import { requireRole } from "../errors";
import { breakEvenFor, profitTargetForEvent } from "./analysis";
import { getDashboard } from "./dashboard";
import { getEvent, listEvents } from "./events";
import { getFinanceSummary, listTransactions, type TransactionFilter } from "./finance";
import { getMember, listMembers } from "./members";
import { listOrders } from "./merch";
import { listEventTickets } from "./tickets";

/**
 * What a committee account may read.
 *
 * The functions these wrap (`listMembers`, `listTransactions`, …) are also
 * used inside other services and take no actor. Every staff route that sends
 * this data goes through this file instead, so the rule for who may read what
 * is in one place and holds whichever route calls it:
 *
 *   member records            president, treasurer
 *   ledger, summaries, totals president, treasurer
 *   merchandise orders        president, treasurer
 *   events and registrations  every committee role, without ledger figures
 *                             for a role that may not see the ledger
 */

type Actor = SessionUser | null | undefined;

export async function viewMembers(actor: Actor): Promise<Member[]> {
  requireRole(actor, ...CAN.manageMembers);
  return listMembers();
}

export async function viewMember(id: string, actor: Actor): Promise<MemberDetail> {
  requireRole(actor, ...CAN.manageMembers);
  return getMember(id);
}

export async function viewTransactions(filter: TransactionFilter, actor: Actor): Promise<Transaction[]> {
  requireRole(actor, ...CAN.manageFinance);
  return listTransactions(filter);
}

export async function viewFinanceSummary(actor: Actor): Promise<FinanceSummary> {
  requireRole(actor, ...CAN.manageFinance);
  return getFinanceSummary();
}

/** Orders carry buyers' names, emails and payment status. */
export async function viewOrders(actor: Actor): Promise<Order[]> {
  requireRole(actor, ...CAN.manageMerch);
  return listOrders();
}

/**
 * An event as `actor` may see it. Use this on anything that sends an event
 * back, including the reply to creating or editing one.
 */
export function eventFor(event: EventSummary, actor: Actor): EventView {
  const user = requireRole(actor, ...ROLES);
  return can(user, "manageFinance") ? event : { ...event, finance: null };
}

export async function viewEvents(actor: Actor): Promise<EventView[]> {
  requireRole(actor, ...ROLES);
  return (await listEvents()).map((event) => eventFor(event, actor));
}

/**
 * One event with its registrations. The organizer runs the door, so they see
 * who is registered and whether each ticket is paid, but not the event's
 * income and costs or the analysis built on them.
 */
export async function viewEvent(id: string, actor: Actor): Promise<EventDetailView> {
  const user = requireRole(actor, ...ROLES);
  const event = await getEvent(id);
  const tickets = await listEventTickets(event.id);
  if (!can(user, "manageFinance")) {
    return { event: eventFor(event, user), tickets, breakEven: null, profitTarget: null };
  }
  return {
    event,
    tickets,
    breakEven: breakEvenFor(event),
    profitTarget: event.profitTargetCents === null ? null : profitTargetForEvent(event),
  };
}

/** The permission an alert's content belongs to; null is shown to every committee role. */
const ALERT_NEEDS: Record<DashboardAlert["kind"], keyof typeof CAN | null> = {
  overdue_tasks: null,
  pending_reimbursements: "manageFinance",
  refunds_due: "manageFinance",
  unpaid_tickets: "manageFinance",
  expiring_members: "manageMembers",
  low_stock: "manageMerch",
};

export async function viewDashboard(actor: Actor): Promise<DashboardView> {
  const user = requireRole(actor, ...ROLES);
  const dashboard = await getDashboard();
  const finance = can(user, "manageFinance");
  return {
    ...dashboard,
    members: can(user, "manageMembers") ? dashboard.members : null,
    finance: finance ? dashboard.finance : null,
    cashflow: finance ? dashboard.cashflow : [],
    eventPerformance: finance
      ? dashboard.eventPerformance
      : dashboard.eventPerformance.map((e) => ({ ...e, incomeSettledCents: null, expenseSettledCents: null, netCents: null })),
    alerts: dashboard.alerts.filter((alert) => {
      const needs = ALERT_NEEDS[alert.kind];
      return needs === null || can(user, needs);
    }),
  };
}
