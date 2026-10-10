/**
 * Shared data contracts.
 *
 * Everything the API accepts (zod schemas) and returns (TypeScript interfaces)
 * is declared here. The file is safe to import from both server and client
 * code. See API_CONTRACTS.md for the endpoint list.
 *
 * Conventions
 * - Money: integer minor units in fields ending `Cents`.
 * - Timestamps: ISO-8601 UTC strings in fields ending `At`.
 * - Calendar dates: "YYYY-MM-DD" strings in fields ending `On`.
 */
import { z } from "zod";
import { isYmd } from "./dates";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SETTINGS = {
  orgName: "Skyline Student Association",
  /** Annual membership dues, minor units. */
  membershipFeeCents: Number(process.env.NEXT_PUBLIC_MEMBERSHIP_FEE_CENTS ?? 50000),
  /** Members whose paid term ends within this many days are flagged for renewal. */
  renewalReminderDays: 30,
  /** A size with this many units or fewer is flagged as low stock. */
  lowStockThreshold: 5,
} as const;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const MAX_CENTS = 1_000_000_000; // 1 crore in major units; guards typos

const text = (min: number, max: number, label: string) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .min(min, `${label} must be at least ${min} characters`)
    .max(max, `${label} must be at most ${max} characters`);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .nullish()
    .transform((v) => (v ? v : null));

const cents = (label: string) =>
  z
    .number({ error: `${label} must be a number` })
    .int(`${label} must be a whole number of minor units`)
    .min(0, `${label} cannot be negative`)
    .max(MAX_CENTS, `${label} is too large`);

const positiveCents = (label: string) => cents(label).min(1, `${label} must be greater than zero`);

const timestamp = (label: string) =>
  z
    .string({ error: `${label} is required` })
    .refine((v) => !Number.isNaN(Date.parse(v)), `${label} is not a valid date and time`)
    .transform((v) => new Date(v).toISOString());

const ymd = (label: string) =>
  z.string({ error: `${label} is required` }).refine(isYmd, `${label} must be a valid date`);

const email = z
  .string({ error: "Email is required" })
  .trim()
  .toLowerCase()
  .max(200, "Email is too long")
  .pipe(z.email("Enter a valid email address"));

const idRef = z
  .string()
  .max(60)
  .nullish()
  .transform((v) => (v ? v : null));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const ROLES = ["admin", "treasurer", "organizer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "President (admin)",
  treasurer: "Treasurer",
  organizer: "Event organizer",
};

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export const loginSchema = z.object({
  email,
  password: z.string({ error: "Password is required" }).min(1, "Password is required").max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** What each role may do. The server enforces this; the UI only reads it to hide controls. */
export const CAN = {
  manageEvents: ["admin", "organizer"],
  checkIn: ["admin", "organizer", "treasurer"],
  collectPayment: ["admin", "organizer", "treasurer"],
  manageFinance: ["admin", "treasurer"],
  fileExpenseClaim: ["admin", "treasurer", "organizer"],
  manageMembers: ["admin", "treasurer"],
  manageTasks: ["admin", "organizer", "treasurer"],
  manageAnnouncements: ["admin", "organizer"],
  manageMerch: ["admin", "treasurer"],
} as const satisfies Record<string, readonly Role[]>;

export function can(user: SessionUser | null | undefined, action: keyof typeof CAN): boolean {
  return !!user && (CAN[action] as readonly Role[]).includes(user.role);
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export const PAYMENT_METHODS = ["cash", "upi", "card", "bank", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  bank: "Bank transfer",
  other: "Other",
};

export const paymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS).default("cash"),
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const EVENT_STATUSES = ["draft", "published", "cancelled"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type EventPhase = "upcoming" | "live" | "past";

export const eventInputSchema = z
  .object({
    title: text(3, 120, "Title"),
    description: z.string().trim().max(2000, "Description is too long").default(""),
    venue: text(2, 160, "Venue"),
    startsAt: timestamp("Start"),
    endsAt: timestamp("End"),
    capacity: z
      .number({ error: "Capacity must be a number" })
      .int("Capacity must be a whole number")
      .min(1, "Capacity must be at least 1")
      .max(100000, "Capacity is too large"),
    priceCents: cents("Standard price"),
    memberPriceCents: cents("Member price"),
    profitTargetCents: cents("Profit target").nullish().transform((v) => v ?? null),
  })
  .superRefine((v, ctx) => {
    if (Date.parse(v.endsAt) <= Date.parse(v.startsAt)) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must be after the start" });
    }
    if (v.memberPriceCents > v.priceCents) {
      ctx.addIssue({
        code: "custom",
        path: ["memberPriceCents"],
        message: "Member price cannot be higher than the standard price",
      });
    }
  });
export type EventInput = z.infer<typeof eventInputSchema>;

export const eventStatusSchema = z.object({ status: z.enum(EVENT_STATUSES) });

export interface EventStats {
  registered: number;
  remaining: number;
  paid: number;
  pending: number;
  free: number;
  checkedIn: number;
  /** checkedIn / registered, 0–1. Null until the event has started or nobody registered. */
  attendanceRate: number | null;
}

export interface EventFinance {
  /** Collected income linked to the event. */
  incomeSettledCents: number;
  /** Income recorded but not yet collected. */
  incomePendingCents: number;
  /** Expenses already paid out. */
  expenseSettledCents: number;
  /** Expenses owed (claims, refunds due). */
  expensePendingCents: number;
  ticketIncomeSettledCents: number;
  ticketIncomePendingCents: number;
  /** Actual result: collected income − paid expenses. */
  netCents: number;
  /** Estimate: result if every pending item settles as recorded. */
  projectedNetCents: number;
}

export interface EventSummary {
  id: string;
  title: string;
  description: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  priceCents: number;
  memberPriceCents: number;
  profitTargetCents: number | null;
  status: EventStatus;
  phase: EventPhase;
  createdAt: string;
  updatedAt: string;
  stats: EventStats;
  finance: EventFinance;
}

export interface PublicEvent {
  id: string;
  title: string;
  description: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  remaining: number;
  priceCents: number;
  memberPriceCents: number;
  phase: EventPhase;
  registrationOpen: boolean;
  closedReason: "sold_out" | "ended" | null;
}

export interface EventStatusChange {
  event: EventSummary;
  /** Pending ticket payments cancelled because the event was cancelled. */
  voidedPendingCount: number;
  /** Refunds now owed for tickets that were already paid. */
  refundsDueCents: number;
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export const registrationInputSchema = z.object({
  name: text(2, 100, "Name"),
  email,
  studentId: optionalText(40),
  /** Member price applies only when this number and the email match an active member. */
  memberNo: optionalText(20),
});
export type RegistrationInput = z.infer<typeof registrationInputSchema>;

/** Staff registering someone at the desk may also record payment on the spot. */
export const staffRegistrationSchema = registrationInputSchema.extend({
  payNow: z.enum(PAYMENT_METHODS).nullish().transform((v) => v ?? null),
});
export type StaffRegistrationInput = z.infer<typeof staffRegistrationSchema>;

export type TicketPaymentStatus = "free" | "pending" | "paid";
export type TicketStatus = "valid" | "cancelled";

export interface Ticket {
  id: string;
  code: string;
  eventId: string;
  eventTitle: string;
  attendeeName: string;
  attendeeEmail: string;
  studentId: string | null;
  memberId: string | null;
  memberNo: string | null;
  priceCents: number;
  paymentStatus: TicketPaymentStatus;
  status: TicketStatus;
  checkedInAt: string | null;
  checkedInByName: string | null;
  createdAt: string;
}

/** What anyone holding a ticket code may see. Deliberately has no email. */
export interface PublicTicket {
  code: string;
  attendeeName: string;
  isMember: boolean;
  priceCents: number;
  paymentStatus: TicketPaymentStatus;
  status: TicketStatus;
  checkedInAt: string | null;
  event: {
    id: string;
    title: string;
    venue: string;
    startsAt: string;
    endsAt: string;
    status: EventStatus;
  };
  /** Inline SVG markup of the QR code that encodes `code`. */
  qrSvg: string;
}

export const checkInSchema = z.object({
  code: z.string({ error: "Enter a ticket code" }).trim().min(1, "Enter a ticket code").max(200),
  /** When set, tickets for any other event are refused as `wrong_event`. */
  eventId: idRef,
  /** Record payment for an unpaid ticket and check in, in one step. */
  collectPayment: z.boolean().default(false),
  method: z.enum(PAYMENT_METHODS).default("cash"),
});
export type CheckInInput = z.infer<typeof checkInSchema>;

export const verifySchema = checkInSchema.pick({ code: true, eventId: true });

export const TICKET_ACTIONS = ["pay", "cancel", "undo_check_in"] as const;
export const ticketActionSchema = z.object({
  action: z.enum(TICKET_ACTIONS),
  method: z.enum(PAYMENT_METHODS).default("cash"),
});

export type CheckInOutcome =
  | "checked_in"
  | "valid" // verify only: the ticket would be admitted
  | "already_checked_in"
  | "payment_required"
  | "cancelled"
  | "event_cancelled"
  | "wrong_event"
  | "not_found";

export interface CheckInResult {
  outcome: CheckInOutcome;
  message: string;
  ticket: {
    code: string;
    attendeeName: string;
    eventId: string;
    eventTitle: string;
    isMember: boolean;
    memberNo: string | null;
    priceCents: number;
    paymentStatus: TicketPaymentStatus;
    checkedInAt: string | null;
    checkedInByName: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export const TRANSACTION_TYPES = ["income", "expense"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = ["settled", "pending"] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const INCOME_CATEGORIES = [
  "tickets",
  "dues",
  "merchandise",
  "sponsorship",
  "fundraiser",
  "donation",
  "other_income",
] as const;

export const EXPENSE_CATEGORIES = [
  "venue",
  "catering",
  "supplies",
  "marketing",
  "equipment",
  "merchandise_stock",
  "reimbursement",
  "refund",
  "other_expense",
] as const;

export type TransactionCategory =
  | (typeof INCOME_CATEGORIES)[number]
  | (typeof EXPENSE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<TransactionCategory, string> = {
  tickets: "Ticket sales",
  dues: "Membership dues",
  merchandise: "Merchandise sales",
  sponsorship: "Sponsorship",
  fundraiser: "Fundraiser",
  donation: "Donation",
  other_income: "Other income",
  venue: "Venue",
  catering: "Food & catering",
  supplies: "Supplies",
  marketing: "Marketing & printing",
  equipment: "Equipment",
  merchandise_stock: "Merchandise stock",
  reimbursement: "Volunteer reimbursement",
  refund: "Refund",
  other_expense: "Other expense",
};

export const transactionInputSchema = z
  .object({
    type: z.enum(TRANSACTION_TYPES, { error: "Choose income or expense" }),
    category: z.enum([...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES], { error: "Choose a category" }),
    amountCents: positiveCents("Amount"),
    status: z.enum(TRANSACTION_STATUSES).default("settled"),
    occurredOn: ymd("Date"),
    description: text(2, 200, "Description"),
    counterparty: optionalText(120),
    method: z.enum(PAYMENT_METHODS).nullish().transform((v) => v ?? null),
    eventId: idRef,
  })
  .superRefine((v, ctx) => {
    const allowed: readonly string[] = v.type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    if (!allowed.includes(v.category)) {
      ctx.addIssue({
        code: "custom",
        path: ["category"],
        message: `That category does not apply to ${v.type}`,
      });
    }
  });
export type TransactionInput = z.infer<typeof transactionInputSchema>;

export const settleSchema = z.object({
  method: z.enum(PAYMENT_METHODS).nullish().transform((v) => v ?? null),
});
export const voidSchema = z.object({ reason: text(3, 200, "Reason") });

export const transactionActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("settle"),
    method: z.enum(PAYMENT_METHODS).nullish().transform((v) => v ?? null),
  }),
  z.object({ action: z.literal("void"), reason: text(3, 200, "Reason") }),
]);

/** Where a transaction came from. Only `manual` rows can be edited or voided by hand. */
export type TransactionSource = "manual" | "ticket" | "dues" | "order" | "refund";

export interface Transaction {
  id: string;
  type: TransactionType;
  category: TransactionCategory;
  amountCents: number;
  status: TransactionStatus;
  occurredOn: string;
  description: string;
  counterparty: string | null;
  method: PaymentMethod | null;
  source: TransactionSource;
  eventId: string | null;
  eventTitle: string | null;
  ticketId: string | null;
  memberId: string | null;
  orderId: string | null;
  createdByName: string | null;
  createdAt: string;
  settledAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface FinanceTotals {
  incomeSettledCents: number;
  incomePendingCents: number;
  expenseSettledCents: number;
  expensePendingCents: number;
  /** Actual: collected income − paid expenses. Also the cash balance. */
  netCents: number;
  /** Estimate: net if every pending item settles as recorded. */
  projectedNetCents: number;
}

export interface FinanceSummary extends FinanceTotals {
  transactionCount: number;
  byCategory: {
    type: TransactionType;
    category: TransactionCategory;
    settledCents: number;
    pendingCents: number;
    count: number;
  }[];
  /** Settled amounts only, oldest month first. */
  byMonth: { month: string; incomeCents: number; expenseCents: number; netCents: number }[];
  /** One row per event that has transactions, plus `eventId: null` for the rest. */
  byEvent: ({ eventId: string | null; title: string } & EventFinance)[];
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const memberInputSchema = z.object({
  name: text(2, 100, "Name"),
  email,
  studentId: optionalText(40),
  phone: optionalText(30),
  /** Record this term's dues as collected now. Staff only. */
  duesPaid: z.boolean().default(false),
  method: z.enum(PAYMENT_METHODS).default("cash"),
  /** Last day of the first term. Defaults to 31 December of the current year. */
  expiresOn: ymd("Expiry date").nullish().transform((v) => v ?? null),
});
export type MemberInput = z.infer<typeof memberInputSchema>;

export const memberJoinSchema = memberInputSchema.pick({
  name: true,
  email: true,
  studentId: true,
  phone: true,
});
export type MemberJoinInput = z.infer<typeof memberJoinSchema>;

export const memberUpdateSchema = memberInputSchema.pick({
  name: true,
  email: true,
  studentId: true,
  phone: true,
});

export const renewSchema = z.object({
  duesPaid: z.boolean().default(true),
  method: z.enum(PAYMENT_METHODS).default("cash"),
});
export type RenewInput = z.infer<typeof renewSchema>;

export const memberActionSchema = z.object({
  action: z.enum(["renew", "collect_dues"]),
  duesPaid: z.boolean().default(true),
  method: z.enum(PAYMENT_METHODS).default("cash"),
});

/**
 * active   — a paid term covers today
 * expiring — active, but the paid term ends within the reminder window
 * lapsed   — had a paid term that has ended
 * unpaid   — signed up but dues were never collected
 */
export type MemberStatus = "active" | "expiring" | "lapsed" | "unpaid";

export interface Member {
  id: string;
  memberNo: string;
  name: string;
  email: string;
  studentId: string | null;
  phone: string | null;
  joinedOn: string;
  /** Last day covered by a paid term, if any. */
  paidUntilOn: string | null;
  /** Dues recorded but not yet collected. */
  duesOwedCents: number;
  status: MemberStatus;
  /** Days until the paid term ends; negative once lapsed; null if never paid. */
  daysToExpiry: number | null;
  createdAt: string;
}

export interface MembershipPeriod {
  id: string;
  kind: "new" | "renewal";
  startsOn: string;
  endsOn: string;
  amountCents: number;
  paidAt: string | null;
  createdAt: string;
}

export interface MemberDetail extends Member {
  periods: MembershipPeriod[];
  tickets: {
    code: string;
    eventId: string;
    eventTitle: string;
    startsAt: string;
    priceCents: number;
    paymentStatus: TicketPaymentStatus;
    status: TicketStatus;
    checkedInAt: string | null;
  }[];
  orders: {
    code: string;
    productName: string;
    size: string;
    quantity: number;
    totalCents: number;
    paymentStatus: "pending" | "paid";
    status: OrderStatus;
    createdAt: string;
  }[];
}

/** Returned to a student who signs up on the public page. */
export interface JoinResult {
  memberNo: string;
  name: string;
  duesOwedCents: number;
}

// ---------------------------------------------------------------------------
// Volunteer tasks
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

export const taskInputSchema = z.object({
  title: text(2, 140, "Title"),
  description: z.string().trim().max(1000, "Description is too long").default(""),
  assignee: optionalText(80),
  dueOn: ymd("Due date").nullish().transform((v) => v ?? null),
  status: z.enum(TASK_STATUSES).default("todo"),
  eventId: idRef,
});
export type TaskInput = z.infer<typeof taskInputSchema>;

export const taskStatusSchema = z.object({ status: z.enum(TASK_STATUSES) });

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string | null;
  dueOn: string | null;
  status: TaskStatus;
  eventId: string | null;
  eventTitle: string | null;
  isOverdue: boolean;
  /** Days past the due date; 0 when not overdue. */
  daysOverdue: number;
  createdAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export const ANNOUNCEMENT_AUDIENCES = ["everyone", "members"] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export const announcementInputSchema = z.object({
  title: text(3, 140, "Title"),
  body: text(3, 4000, "Message"),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).default("everyone"),
});
export type AnnouncementInput = z.infer<typeof announcementInputSchema>;

export interface Announcement {
  id: string;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  authorName: string | null;
  publishedAt: string;
}

export interface PublicAnnouncement {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
}

// ---------------------------------------------------------------------------
// Merchandise
// ---------------------------------------------------------------------------

export const productInputSchema = z
  .object({
    name: text(2, 100, "Name"),
    description: z.string().trim().max(600, "Description is too long").default(""),
    priceCents: positiveCents("Price"),
    memberPriceCents: positiveCents("Member price"),
    active: z.boolean().default(true),
    variants: z
      .array(
        z.object({
          size: text(1, 20, "Size"),
          stock: z
            .number({ error: "Stock must be a number" })
            .int("Stock must be a whole number")
            .min(0, "Stock cannot be negative")
            .max(100000, "Stock is too large"),
        }),
      )
      .min(1, "Add at least one size")
      .max(12, "Too many sizes"),
  })
  .superRefine((v, ctx) => {
    if (v.memberPriceCents > v.priceCents) {
      ctx.addIssue({
        code: "custom",
        path: ["memberPriceCents"],
        message: "Member price cannot be higher than the standard price",
      });
    }
    const sizes = v.variants.map((s) => s.size.toLowerCase());
    if (new Set(sizes).size !== sizes.length) {
      ctx.addIssue({ code: "custom", path: ["variants"], message: "Each size must be unique" });
    }
  });
export type ProductInput = z.infer<typeof productInputSchema>;

export const productUpdateSchema = z.object({
  name: text(2, 100, "Name"),
  description: z.string().trim().max(600).default(""),
  priceCents: positiveCents("Price"),
  memberPriceCents: positiveCents("Member price"),
  active: z.boolean(),
});

export const stockUpdateSchema = z.object({
  variantId: z.string().min(1),
  stock: z
    .number({ error: "Stock must be a number" })
    .int("Stock must be a whole number")
    .min(0, "Stock cannot be negative")
    .max(100000, "Stock is too large"),
});

export interface ProductVariant {
  id: string;
  size: string;
  stock: number;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  memberPriceCents: number;
  active: boolean;
  variants: ProductVariant[];
  totalStock: number;
  /** Units in orders that are not cancelled. */
  unitsSold: number;
}

export interface PublicProduct {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  memberPriceCents: number;
  variants: { id: string; size: string; inStock: boolean; stock: number }[];
}

export const orderInputSchema = z.object({
  productId: z.string().min(1, "Choose a product"),
  variantId: z.string().min(1, "Choose a size"),
  quantity: z
    .number({ error: "Quantity must be a number" })
    .int("Quantity must be a whole number")
    .min(1, "Order at least one")
    .max(10, "At most 10 per order"),
  name: text(2, 100, "Name"),
  email,
  memberNo: optionalText(20),
});
export type OrderInput = z.infer<typeof orderInputSchema>;

export const ORDER_ACTIONS = ["pay", "fulfil", "cancel"] as const;
export const orderActionSchema = z.object({
  action: z.enum(ORDER_ACTIONS),
  method: z.enum(PAYMENT_METHODS).default("cash"),
});

export type OrderStatus = "placed" | "fulfilled" | "cancelled";

export interface Order {
  id: string;
  code: string;
  productId: string;
  productName: string;
  size: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  buyerName: string;
  buyerEmail: string;
  memberNo: string | null;
  paymentStatus: "pending" | "paid";
  status: OrderStatus;
  createdAt: string;
}

export interface PublicOrder {
  code: string;
  productName: string;
  size: string;
  quantity: number;
  totalCents: number;
  isMember: boolean;
  paymentStatus: "pending" | "paid";
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardAlert {
  kind:
    | "overdue_tasks"
    | "pending_reimbursements"
    | "unpaid_tickets"
    | "expiring_members"
    | "low_stock"
    | "refunds_due";
  severity: "warning" | "info";
  title: string;
  detail: string;
  href: string;
}

export interface Dashboard {
  generatedAt: string;
  members: {
    total: number;
    active: number;
    expiring: number;
    lapsed: number;
    unpaid: number;
  };
  events: {
    total: number;
    upcoming: number;
    past: number;
    draft: number;
    next: { id: string; title: string; startsAt: string; registered: number; capacity: number } | null;
  };
  tickets: {
    registered: number;
    paid: number;
    pending: number;
    free: number;
    checkedIn: number;
    /** Across events that have started: checked in / registered. */
    attendanceRate: number | null;
  };
  finance: FinanceTotals;
  tasks: { open: number; overdue: number; done: number };
  eventPerformance: {
    id: string;
    title: string;
    startsAt: string;
    status: EventStatus;
    phase: EventPhase;
    capacity: number;
    registered: number;
    checkedIn: number;
    incomeSettledCents: number;
    expenseSettledCents: number;
    netCents: number;
  }[];
  cashflow: FinanceSummary["byMonth"];
  alerts: DashboardAlert[];
}

// ---------------------------------------------------------------------------
// Event analysis (deterministic; shared by the event page and the assistant)
// ---------------------------------------------------------------------------

export interface BreakEvenScenario {
  label: string;
  priceCents: number;
  /** Total tickets that must be paid for at this price to cover costs. */
  ticketsNeeded: number;
  /** Still to sell, after counting tickets already registered. */
  moreTicketsNeeded: number;
  /** False when the event's capacity is too small to get there. */
  achievable: boolean;
}

export interface BreakEvenAnalysis {
  eventId: string;
  title: string;
  /** All linked expenses, paid and owed. */
  costCents: number;
  /** Linked income that is not ticket sales (sponsorship, donations…). */
  otherIncomeCents: number;
  /** costCents − otherIncomeCents, floored at zero: what ticket sales must cover. */
  toCoverCents: number;
  ticketIncomeCents: number;
  ticketsRegistered: number;
  capacity: number;
  alreadyCovered: boolean;
  /** Empty when tickets are free. */
  scenarios: BreakEvenScenario[];
}

export interface ProfitTargetAnalysis {
  scope: "event" | "organisation";
  eventId: string | null;
  title: string;
  targetCents: number;
  /** Actual net: collected income − paid expenses. */
  actualNetCents: number;
  /** Estimate: net if all pending items settle. */
  projectedNetCents: number;
  /** Still needed on the actual figure. */
  gapActualCents: number;
  /** Still needed even if all pending items settle. */
  gapProjectedCents: number;
  /** Events only: extra standard-price tickets that would close the projected gap. */
  ticketsToCloseGap: number | null;
  seatsRemaining: number | null;
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

export const assistantQuestionSchema = z.object({
  question: text(2, 500, "Question"),
});

export type AssistantFactKind = "actual" | "estimate" | "recommendation";

export interface AssistantFact {
  label: string;
  value: string;
  /**
   * actual         — read directly from stored records
   * estimate       — calculated from records plus a stated assumption
   * recommendation — a suggested action, not a fact
   */
  kind: AssistantFactKind;
}

export interface AssistantAnswer {
  /** Which engine produced the wording. Numbers always come from application code. */
  engine: "rules" | "claude";
  engineLabel: string;
  intent: string;
  answer: string;
  facts: AssistantFact[];
  /** Which records the answer was computed from. */
  sources: string[];
  /** Set when the assistant fell back or could not fully answer. */
  notice: string | null;
  suggestions: string[];
}

// ---------------------------------------------------------------------------
// API envelope
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}
export interface ApiSuccessBody<T> {
  data: T;
}
