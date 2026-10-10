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

/**
 * Staff hold one of the three roles above. A member account is a separate
 * kind of sign-in with the role "member": it can never appear in a staff role
 * list, so no staff permission can be granted to it by accident.
 */
export type AccountRole = Role | "member";

export const ROLE_LABELS: Record<AccountRole, string> = {
  admin: "President (admin)",
  treasurer: "Treasurer",
  organizer: "Event organizer",
  member: "Member",
};

export interface SessionUser {
  /** A staff user id, or the member id for a member account. */
  id: string;
  name: string;
  email: string;
  role: AccountRole;
  /** Set only for member accounts. */
  memberId: string | null;
  memberNo: string | null;
}

export const isStaff = (user: SessionUser | null | undefined): boolean =>
  !!user && user.role !== "member";

export const loginSchema = z.object({
  /** Staff sign in with their email; members with their email or member ID. */
  email: z
    .string({ error: "Enter your email or member ID" })
    .trim()
    .min(1, "Enter your email or member ID")
    .max(200, "That is too long"),
  password: z.string({ error: "Password is required" }).min(1, "Password is required").max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const MEMBER_PASSWORD_MIN = 10;

export const setupTokenSchema = z.object({
  token: z.string({ error: "This link is incomplete" }).min(20, "This link is incomplete").max(200),
});

export const passwordSetupSchema = setupTokenSchema.extend({
  password: z
    .string({ error: "Choose a password" })
    .min(MEMBER_PASSWORD_MIN, `Use at least ${MEMBER_PASSWORD_MIN} characters`)
    .max(200, "Password is too long"),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string({ error: "Enter your current password" }).min(1, "Enter your current password").max(200),
  newPassword: z
    .string({ error: "Choose a new password" })
    .min(MEMBER_PASSWORD_MIN, `Use at least ${MEMBER_PASSWORD_MIN} characters`)
    .max(200, "Password is too long"),
});

/** The only fields a member may change about themselves. Name, email and member ID belong to the committee. */
export const memberProfileSchema = z.object({
  phone: optionalText(30),
  studentId: optionalText(40),
});

/** A line from the ledger that concerns the signed-in member: dues, tickets, orders, claim repayments. */
export interface MemberPayment {
  id: string;
  description: string;
  /** "income" is money the member pays the club; "expense" is money the club pays the member. */
  type: "income" | "expense";
  amountCents: number;
  status: "settled" | "pending";
  occurredOn: string;
  method: string | null;
}

/** What the holder of a valid setup link is shown before choosing a password. */
export interface SetupTokenInfo {
  memberNo: string;
  name: string;
  expiresAt: string;
}

/** A one-time password-setup link. The path is shown once, to the staff member who issued it. */
export interface SetupLink {
  path: string;
  expiresAt: string;
  memberNo: string;
  name: string;
  email: string;
}

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
  return !!user && (CAN[action] as readonly string[]).includes(user.role);
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

// --- Expense claims -----------------------------------------------------------

/** What a claim may be filed under. Refunds and stock purchases are not claims. */
export const CLAIM_CATEGORIES = ["supplies", "catering", "marketing", "equipment", "venue", "other_expense"] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];

/**
 * Sent as form fields, with the receipt photo in a file field named `evidence`.
 * The photo is required; the server refuses a claim without one.
 */
export const claimInputSchema = z.object({
  title: text(3, 120, "What you bought"),
  // Form fields arrive as text.
  amountCents: z.coerce
    .number({ error: "Amount must be a number" })
    .int("Amount must be a whole number of minor units")
    .min(1, "Amount must be greater than zero")
    .max(MAX_CENTS, "Amount is too large"),
  spentOn: ymd("Expense date"),
  category: z.enum(CLAIM_CATEGORIES, { error: "Choose a category" }),
  justification: text(10, 600, "Why it was needed"),
  notes: optionalText(600),
  eventId: idRef,
});
export type ClaimInput = z.infer<typeof claimInputSchema>;

export const CLAIM_STATUSES = ["submitted", "under_review", "approved", "rejected", "paid"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  submitted: "Submitted",
  under_review: "Under review",
  approved: "Approved, to be paid",
  rejected: "Rejected",
  paid: "Paid",
};

export const claimReviewSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start_review") }),
  z.object({ action: z.literal("approve"), note: optionalText(300) }),
  z.object({ action: z.literal("reject"), reason: text(3, 300, "Reason") }),
  z.object({ action: z.literal("pay"), method: z.enum(PAYMENT_METHODS, { error: "Choose how it was paid" }) }),
]);
export type ClaimReviewInput = z.infer<typeof claimReviewSchema>;

export interface ExpenseClaim {
  id: string;
  code: string;
  claimantName: string;
  /** "member" or "staff": who filed it. */
  claimantKind: "member" | "staff";
  /** True when the signed-in account filed this claim. Nobody reviews their own. */
  isMine: boolean;
  title: string;
  justification: string;
  notes: string | null;
  category: ClaimCategory;
  amountCents: number;
  spentOn: string;
  eventId: string | null;
  eventTitle: string | null;
  /** Fetch the photo from `/api/files/:id`. Reviewers and the claimant only. */
  evidenceFileId: string;
  status: ClaimStatus;
  reviewNote: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  /** The ledger entry created on approval. */
  transactionId: string | null;
  createdAt: string;
}

/** Whether the signed-in account may file claims, and why not if it may not. */
export interface ClaimAccess {
  canSubmit: boolean;
  canReview: boolean;
  reason: string | null;
}

export interface ClaimList extends ClaimAccess {
  claims: ExpenseClaim[];
}

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
  /** Set when the entry was created by approving an expense claim. It then follows the claim. */
  claimId: string | null;
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
  /** True once the member has set a password and can sign in. */
  hasAccount: boolean;
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

// ---------------------------------------------------------------------------
// Membership applications
// ---------------------------------------------------------------------------

/** How an applicant says they paid. A subset of PAYMENT_METHODS. */
export const APPLICATION_METHODS = ["upi", "bank", "cash"] as const;
export type ApplicationMethod = (typeof APPLICATION_METHODS)[number];
export const APPLICATION_METHOD_LABELS: Record<ApplicationMethod, string> = {
  upi: "UPI",
  bank: "Bank transfer",
  cash: "Cash to a committee member",
};

/** Sent as form fields, with the payment screenshot in a file field named `evidence`. */
export const applicationInputSchema = z.object({
  name: text(2, 100, "Name"),
  email,
  studentId: optionalText(40),
  phone: optionalText(30),
  paymentMethod: z.enum(APPLICATION_METHODS, { error: "Choose how you paid" }),
  /** UPI or bank reference number, or for cash, who took the money. */
  paymentReference: text(4, 80, "Payment reference"),
});
export type ApplicationInput = z.infer<typeof applicationInputSchema>;

export type ApplicationStatus = "pending" | "approved" | "rejected";

/** What an applicant gets back. Nothing here says the payment was verified. */
export interface ApplicationReceipt {
  code: string;
  status: ApplicationStatus;
  amountCents: number;
}

export const applicationStatusSchema = z.object({
  code: text(4, 20, "Application code"),
  email,
});

/** Shown to someone who supplies both the application code and its email. */
export interface ApplicationStatusView {
  code: string;
  status: ApplicationStatus;
  submittedAt: string;
  reviewNote: string | null;
  /** Set once approved. */
  memberNo: string | null;
  /** For an online application that is not a member yet: where its payment stands. */
  online: OnlineApplicationStatus | null;
}

export interface MembershipApplication {
  id: string;
  code: string;
  name: string;
  email: string;
  studentId: string | null;
  phone: string | null;
  amountCents: number;
  paymentMethod: ApplicationMethod;
  paymentReference: string;
  /** Fetch the image from `/api/files/:id`. Reviewers only. */
  evidenceFileId: string | null;
  status: ApplicationStatus;
  reviewNote: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  memberId: string | null;
  memberNo: string | null;
  /** `razorpay` rows were paid online and approved by the verified payment, not by a reviewer. */
  channel: ApplicationChannel;
  createdAt: string;
}

export const applicationReviewSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    /** The reviewer states that they checked the club's account and the money arrived. */
    paymentReceived: z.literal(true, { error: "Confirm that the payment was received" }),
  }),
  z.object({ action: z.literal("reject"), reason: text(3, 300, "Reason") }),
]);

export interface ApplicationReview {
  application: MembershipApplication;
  /** Present after an approval: the link the new member uses to set a password. */
  setup: SetupLink | null;
}

/** How to pay the membership fee. `upi` is null until the club's UPI ID is configured. */
export interface PaymentInstructions {
  feeCents: number;
  upi: { payeeName: string; vpa: string; qrSvg: string } | null;
  /** Whether the fee can be paid online right now. */
  online: { available: boolean };
}

// ---------------------------------------------------------------------------
// Paying the membership fee online (Razorpay)
// ---------------------------------------------------------------------------

/** Where an application came from: the manual form, or an online payment. */
export type ApplicationChannel = "manual" | "razorpay";

export const ONLINE_APPLICATION_STATUSES = [
  "pending",
  "failed",
  "superseded",
  "activated",
  "needs_review",
  "refunded",
] as const;
/**
 * - `pending`: an order exists and has not been paid.
 * - `failed`: the last attempt failed or was abandoned; it can be paid again.
 * - `superseded`: the person started a newer application.
 * - `activated`: the payment was verified and the member created.
 * - `needs_review`: the payment was verified, but no member could be created.
 * - `refunded`: a reviewer returned a `needs_review` payment.
 */
export type OnlineApplicationStatus = (typeof ONLINE_APPLICATION_STATUSES)[number];
export const ONLINE_APPLICATION_STATUS_LABELS: Record<OnlineApplicationStatus, string> = {
  pending: "Awaiting payment",
  failed: "Payment failed",
  superseded: "Replaced",
  activated: "Paid · member created",
  needs_review: "Paid · needs review",
  refunded: "Refunded",
};

export const onlineApplicationInputSchema = z.object({
  name: text(2, 100, "Name"),
  email,
  studentId: optionalText(40),
  phone: optionalText(30),
});
export type OnlineApplicationInput = z.infer<typeof onlineApplicationInputSchema>;

/** The secret a browser gets when it starts an online application. */
const accessToken = z.string().min(20).max(100);

/**
 * What the applicant's browser may ask about its own application. Every
 * action needs the access token. `confirm` carries what Razorpay Checkout
 * returned; the server verifies it and never takes it as proof on its own.
 */
export const onlineApplicationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resume"), token: accessToken }),
  z.object({
    action: z.literal("confirm"),
    token: accessToken,
    razorpayOrderId: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/),
    razorpayPaymentId: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/),
    razorpaySignature: z.string().regex(/^[a-fA-F0-9]{64}$/),
  }),
  z.object({ action: z.literal("failed"), token: accessToken, reason: optionalText(200) }),
  z.object({ action: z.literal("new_link"), token: accessToken }),
]);
export type OnlineApplicationAction = z.infer<typeof onlineApplicationActionSchema>;

/** What Razorpay Checkout needs to take the payment. The key ID is public; the secret never leaves the server. */
export interface OnlineCheckout {
  keyId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  name: string;
  email: string;
  phone: string | null;
}

/** An online application as its own applicant sees it. */
export interface OnlineApplicationState {
  id: string;
  code: string;
  status: OnlineApplicationStatus;
  amountCents: number;
  /** A payment exists but Razorpay has not finished it yet. Nothing is activated. */
  processing: boolean;
  failureReason: string | null;
  /** Set once the payment is verified and the member exists. */
  memberNo: string | null;
  /** Present while the application can still be paid. */
  checkout: OnlineCheckout | null;
  /** The one-time password link. Only ever sent after a verified payment, to the holder of the access token. */
  setup: SetupLink | null;
  /** Whether the holder may ask for a replacement link (`new_link`). */
  canRequestLink: boolean;
}

/** Returned once, when the application is started. The token is not stored readably anywhere. */
export interface OnlineApplicationStart extends OnlineApplicationState {
  accessToken: string;
}

/** An online application as the treasurer and president see it. */
export interface OnlinePayment {
  id: string;
  code: string;
  name: string;
  email: string;
  studentId: string | null;
  phone: string | null;
  amountCents: number;
  currency: string;
  status: OnlineApplicationStatus;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  paymentMethod: string | null;
  paidAt: string | null;
  verifiedVia: "checkout" | "webhook" | "lookup" | null;
  failureReason: string | null;
  /** Why a paid application could not become a member automatically. */
  reviewReason: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  memberId: string | null;
  memberNo: string | null;
  /** Whether the member has set a password yet. */
  hasAccount: boolean;
  createdAt: string;
}

/**
 * What a reviewer may do with an online application:
 * - `check`: ask Razorpay whether the order was paid, and finish it if so.
 * - `activate`: try again to create the member for a paid application.
 * - `refunded`: record that the payment was returned in the Razorpay dashboard.
 */
export const onlineReconcileSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check") }),
  z.object({ action: z.literal("activate") }),
  z.object({ action: z.literal("refunded"), note: text(3, 300, "Note") }),
]);
export type OnlineReconcileAction = z.infer<typeof onlineReconcileSchema>;

export interface OnlineReconcileResult {
  payment: OnlinePayment;
  /** Present when this action created the member: the link to pass on. */
  setup: SetupLink | null;
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
  /** A name, for a volunteer who is not a member. Ignored when `assigneeMemberId` is set. */
  assignee: optionalText(80),
  /** Assign to a member: the task then appears in that member's own task list. */
  assigneeMemberId: idRef,
  dueOn: ymd("Due date").nullish().transform((v) => v ?? null),
  eventId: idRef,
});
export type TaskInput = z.infer<typeof taskInputSchema>;

/**
 * The only ways a task's status changes. Each applies to exactly one status:
 * start (to do → in progress), done (in progress → done), reopen (done → in progress).
 */
export const TASK_ACTIONS = ["start", "done", "reopen"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];
export const taskActionSchema = z.object({
  action: z.enum(TASK_ACTIONS, { error: "Choose start, done or reopen" }),
});

/** The one action available for a task in each status. */
export const TASK_NEXT_ACTION: Record<TaskStatus, { action: TaskAction; label: string }> = {
  todo: { action: "start", label: "Start" },
  in_progress: { action: "done", label: "Done" },
  done: { action: "reopen", label: "Reopen" },
};

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string | null;
  /** Set when the task is assigned to a member, who may then progress it. */
  assigneeMemberId: string | null;
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

export const PRODUCT_CATEGORIES = ["apparel", "accessories", "stationery", "other"] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];
export const PRODUCT_CATEGORY_LABELS: Record<ProductCategory, string> = {
  apparel: "Clothing",
  accessories: "Accessories",
  stationery: "Stationery",
  other: "Other",
};

/** Most photos one product may have. */
export const MAX_PRODUCT_IMAGES = 6;

export const productInputSchema = z
  .object({
    name: text(2, 100, "Name"),
    category: z.enum(PRODUCT_CATEGORIES).default("apparel"),
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

const stockCount = z
  .number({ error: "Stock must be a number" })
  .int("Stock must be a whole number")
  .min(0, "Stock cannot be negative")
  .max(100000, "Stock is too large");

/** Add a size to an existing product. */
export const variantInputSchema = z.object({ size: text(1, 20, "Size"), stock: stockCount });

export const productUpdateSchema = z.object({
  name: text(2, 100, "Name"),
  category: z.enum(PRODUCT_CATEGORIES).default("apparel"),
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

/** A product photo. `url` is public: product photos are shown in the shop. */
export interface ProductImage {
  id: string;
  url: string;
}

export interface Product {
  id: string;
  name: string;
  category: ProductCategory;
  description: string;
  priceCents: number;
  memberPriceCents: number;
  active: boolean;
  images: ProductImage[];
  variants: ProductVariant[];
  totalStock: number;
  /** Units in orders that are not cancelled. */
  unitsSold: number;
}

export interface PublicProduct {
  id: string;
  name: string;
  category: ProductCategory;
  description: string;
  priceCents: number;
  memberPriceCents: number;
  images: ProductImage[];
  variants: { id: string; size: string; inStock: boolean; stock: number }[];
}

/** Most of one size a single checkout may take. */
export const MAX_QUANTITY_PER_LINE = 10;

const cartLine = z.object({
  variantId: z.string({ error: "Choose a size" }).min(1, "Choose a size").max(60),
  quantity: z
    .number({ error: "Quantity must be a number" })
    .int("Quantity must be a whole number")
    .min(1, "Order at least one")
    .max(MAX_QUANTITY_PER_LINE, `At most ${MAX_QUANTITY_PER_LINE} of one size per order`),
});
const cartLines = z.array(cartLine).min(1, "Your cart is empty").max(20, "Too many different items in one order");

/**
 * A cart sent for checkout. It carries only what was chosen: which size and
 * how many. Prices and totals are worked out on the server and anything the
 * browser sends for them is ignored.
 */
export const checkoutInputSchema = z.object({
  items: cartLines,
  name: text(2, 100, "Name"),
  email,
  memberNo: optionalText(20),
});
export type CheckoutInput = z.infer<typeof checkoutInputSchema>;

/** A signed-in member's checkout: who they are comes from the session. */
export const memberCheckoutSchema = z.object({ items: cartLines });

export interface OrderLine {
  orderId: string;
  productId: string;
  productName: string;
  size: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  /** Whether the money has been collected. Separate from hand-over. */
  paymentStatus: "pending" | "paid";
  status: OrderStatus;
}

/** One checkout: everything bought together. Returned after ordering and in order history. */
export interface ShopOrder {
  code: string;
  createdAt: string;
  buyerName: string;
  isMember: boolean;
  /** Sum of the lines that are not cancelled. */
  totalCents: number;
  /** Part of the total not yet collected. */
  unpaidCents: number;
  lines: OrderLine[];
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
  /** The checkout this line was bought in; null for orders placed before checkouts existed. */
  checkoutCode: string | null;
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
// Event analysis (deterministic; shown on the event page)
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
// API envelope
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}
export interface ApiSuccessBody<T> {
  data: T;
}
