import {
  eventInputSchema,
  type EventInput,
  type PaymentMethod,
  type SessionUser,
  type TransactionInput,
} from "@/lib/contracts";
import { addDays, ymdInTz } from "@/lib/dates";
import { completeSetup, countUsers, createSetupToken, createUser } from "./auth";
import { dbKind, setClock, wipeAllData } from "./db";
import { createAnnouncement } from "./services/announcements";
import { submitApplication } from "./services/applications";
import { createEvent, setEventStatus } from "./services/events";
import { createTransaction } from "./services/finance";
import { createMember, listMembers } from "./services/members";
import { removeAllUploads } from "./storage";
import { actOnOrder, createProduct, listOrders, placeOrder } from "./services/merch";
import { createTask, transitionTask } from "./services/tasks";
import { checkIn, listEventTickets, registerForEvent } from "./services/tickets";

/**
 * Demo data for the Skyline Student Association.
 *
 * Everything is created through the same services the app uses, so the seeded
 * records obey every rule (capacity, ledger links, stock). Dates are relative
 * to the moment of seeding, so the demo always looks current. The random
 * choices use a fixed seed, so every reset produces the same story.
 */

export const DEMO_PASSWORD = "skyline-demo";

const DEMO_STAFF = [
  { email: "president@skyline.club", name: "Aarav Mehta", role: "admin" },
  { email: "treasurer@skyline.club", name: "Priya Nair", role: "treasurer" },
  { email: "events@skyline.club", name: "Rohan Das", role: "organizer" },
] as const;

/** A paid-up member who has set a password, so the member side can be shown. */
const DEMO_MEMBER = { email: "ananya.rao@campus.example", name: "Ananya Rao", role: "member" } as const;

export const DEMO_ACCOUNTS = [...DEMO_STAFF, DEMO_MEMBER] as const;

const MEMBER_NAMES = [
  "Ananya Rao", "Kabir Shah", "Meera Iyer", "Dev Malhotra", "Isha Kapoor", "Arjun Reddy",
  "Sana Qureshi", "Vikram Joshi", "Tara Menon", "Nikhil Verma", "Zoya Khan", "Rahul Bose",
  "Diya Patel", "Aditya Singh", "Leela Fernandes", "Karan Gill", "Naina Chopra", "Farhan Ali",
  "Ritika Sen", "Samar Bhatt", "Pooja Hegde", "Yash Agarwal", "Anjali Pillai", "Imran Sheikh",
];

const FIRST = ["Aditi", "Bhavya", "Chirag", "Divya", "Eshan", "Gauri", "Harsh", "Ira", "Jay", "Kavya", "Lakshya", "Mira", "Neel", "Ojas", "Pari", "Reyansh", "Siya", "Tanvi", "Uday", "Vanya"];
const LAST = ["Arora", "Banerjee", "Chauhan", "Desai", "Ghosh", "Jain", "Kulkarni", "Mishra", "Naidu", "Pandey", "Rana", "Saxena", "Thakur", "Varma"];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const emailOf = (name: string, suffix = "") =>
  `${name.toLowerCase().replace(/[^a-z]+/g, ".")}${suffix}@campus.example`;

export interface SeedSummary {
  users: number;
  members: number;
  events: number;
  tickets: number;
  orders: number;
}

export async function seedDemoData(): Promise<SeedSummary> {
  const base = new Date();
  const rand = mulberry32(20261010);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const method = (): PaymentMethod => (rand() < 0.65 ? "upi" : "cash");

  /** Runs `fn` as if it were `days` days from now, and waits for it before the clock goes back. */
  const at = async <T,>(days: number, fn: () => T | Promise<T>): Promise<T> => {
    setClock(() => new Date(base.getTime() + days * 86_400_000));
    try {
      return await fn();
    } finally {
      setClock(null);
    }
  };
  const day = (days: number) => addDays(ymdInTz(base), days);
  /** An instant `days` from today at the given UTC time (12:30 UTC is 6 pm IST). */
  const instant = (days: number, hourUtc: number, minute = 30) => {
    const d = new Date(base.getTime() + days * 86_400_000);
    d.setUTCHours(hourUtc, minute, 0, 0);
    return d.toISOString();
  };

  await removeAllUploads();
  await wipeAllData();

  const staff: SessionUser[] = [];
  for (const account of DEMO_STAFF) staff.push(await createUser({ ...account, password: DEMO_PASSWORD }));
  const [admin, treasurer, organizer] = staff as [SessionUser, SessionUser, SessionUser];

  // --- members ---------------------------------------------------------------
  for (const [i, name] of MEMBER_NAMES.entries()) {
    const input = {
      name,
      email: emailOf(name),
      studentId: `SKY${2023 + (i % 3)}${String(100 + i * 7).padStart(4, "0")}`,
      phone: null,
      method: method(),
    };
    if (i < 16) {
      // Paid annual members who joined over the last two months.
      await at(-70 + i * 3, () => createMember({ ...input, duesPaid: true, expiresOn: null }, admin));
    } else if (i < 19) {
      // Semester passes that end soon: these drive the renewal reminders.
      await at(-60, () => createMember({ ...input, duesPaid: true, expiresOn: day([9, 16, 24][i - 16]) }, admin));
    } else if (i < 21) {
      // Lapsed: the paid term ended a few weeks ago.
      await at(-200, () => createMember({ ...input, duesPaid: true, expiresOn: day([-15, -40][i - 19]) }, admin));
    } else {
      // Added at the campus table; dues not collected yet.
      await at(-3 + (i - 21), () => createMember({ ...input, duesPaid: false, expiresOn: null }, admin));
    }
  }

  // One member has set a password through the same one-time link real members use.
  const demoMember = (await listMembers()).find((m) => m.email === DEMO_MEMBER.email)!;
  await completeSetup((await createSetupToken(demoMember.id, admin.id)).token, DEMO_PASSWORD);

  // Two people have applied and say they paid in cash. Nobody has verified it yet.
  await at(-1, () =>
    submitApplication(
      { name: "Rhea Kulkarni", email: "rhea.kulkarni@campus.example", studentId: "SKY20260412", phone: null, paymentMethod: "cash", paymentReference: "Paid Priya at the freshers' table" },
      null,
    ),
  );
  await at(-0.2, () =>
    submitApplication(
      { name: "Aman Trivedi", email: "aman.trivedi@campus.example", studentId: null, phone: null, paymentMethod: "cash", paymentReference: "Gave cash to Rohan after the meeting" },
      null,
    ),
  );

  const activeMembers = (await listMembers()).filter((m) => m.status === "active" || m.status === "expiring");

  // --- events ----------------------------------------------------------------
  const event = (input: Partial<EventInput> & Pick<EventInput, "title" | "venue" | "startsAt" | "endsAt" | "capacity">) =>
    eventInputSchema.parse({ description: "", priceCents: 0, memberPriceCents: 0, profitTargetCents: null, ...input });

  let guestCount = 0;
  const guest = () => {
    guestCount += 1;
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    return { name, email: emailOf(name, String(guestCount)), studentId: null, memberNo: null };
  };

  /**
   * Publishes an event and fills it. `members` of the registrations are active
   * members paying the member price; `paid` of all registrations pay up front.
   * When `attended` is set, the event has happened and that many checked in.
   */
  async function run(
    input: EventInput,
    plan: { publishDay: number; registrations: number; members: number; paid: number; eventDay: number; attended?: number },
  ) {
    const created = await at(plan.publishDay - 2, () => createEvent(input, organizer));
    await at(plan.publishDay, () => setEventStatus(created.id, "published", organizer));
    for (let i = 0; i < plan.registrations; i++) {
      const member = i < plan.members ? activeMembers[i % activeMembers.length] : null;
      const who = member
        ? { name: member.name, email: member.email, studentId: member.studentId, memberNo: member.memberNo }
        : guest();
      const span = Math.max(1, plan.eventDay - plan.publishDay - 1);
      const registerDay = Math.min(plan.publishDay + 1 + Math.floor(rand() * span), -0.01);
      const payNow = i < plan.paid && input.priceCents > 0 ? method() : null;
      // The organizer registers people; only the treasurer takes their money.
      await at(registerDay, () => registerForEvent(created.id, who, { actor: payNow ? treasurer : organizer, payNow }));
    }
    if (plan.attended !== undefined) {
      const tickets = (await listEventTickets(created.id)).reverse();
      await at(plan.eventDay + 0.02, async () => {
        for (const t of tickets.slice(0, plan.attended)) {
          // People who had not paid settle at the door, as happens in real life.
          await checkIn({ code: t.code, eventId: created.id, collectPayment: true, method: "cash" }, admin);
        }
      });
    }
    return created;
  }

  const ledger = (days: number, actor: SessionUser, t: Omit<TransactionInput, "occurredOn" | "counterparty" | "method" | "eventId"> & Partial<TransactionInput>) =>
    at(Math.min(days, 0), () =>
      createTransaction(
        { counterparty: null, method: t.status === "settled" ? "bank" : null, eventId: null, ...t, occurredOn: day(Math.min(days, 0)) },
        actor,
      ),
    );

  const mixer = await run(
    event({
      title: "Freshers' Welcome Mixer",
      description: "Meet the committee and other first-years over snacks, music and icebreakers.",
      venue: "Student Centre, Hall B",
      startsAt: instant(-35, 12),
      endsAt: instant(-35, 15),
      capacity: 80,
      priceCents: 15000,
      memberPriceCents: 10000,
    }),
    { publishDay: -55, registrations: 52, members: 14, paid: 44, eventDay: -35, attended: 46 },
  );
  await ledger(-42, treasurer, { type: "income", category: "sponsorship", amountCents: 500000, status: "settled", description: "Campus Café sponsorship for the mixer", counterparty: "Campus Café", eventId: mixer.id });
  await ledger(-38, treasurer, { type: "expense", category: "venue", amountCents: 300000, status: "settled", description: "Hall B booking fee", counterparty: "Student Centre", eventId: mixer.id });
  await ledger(-35, treasurer, { type: "expense", category: "catering", amountCents: 650000, status: "settled", description: "Snacks and soft drinks for 80", counterparty: "Tiffin Box Caterers", eventId: mixer.id });
  await ledger(-34, treasurer, { type: "expense", category: "supplies", amountCents: 120000, status: "pending", description: "Balloons, name tags and fairy lights (receipt #214)", counterparty: "Rohan Das", eventId: mixer.id });

  const openMic = await run(
    event({
      title: "Open Mic Night",
      description: "Poetry, stand-up and acoustic sets from students. Sign up at the door to perform.",
      venue: "Amphitheatre",
      startsAt: instant(-20, 13),
      endsAt: instant(-20, 16),
      capacity: 60,
      priceCents: 10000,
      memberPriceCents: 8000,
    }),
    { publishDay: -32, registrations: 21, members: 6, paid: 17, eventDay: -20, attended: 16 },
  );
  await ledger(-21, treasurer, { type: "expense", category: "equipment", amountCents: 450000, status: "settled", description: "Sound system and stage lights hire", counterparty: "Decibel Rentals", eventId: openMic.id });

  const bakeSale = await run(
    event({
      title: "Charity Bake Sale",
      description: "Volunteers bake, the club sells, and the proceeds fund this semester's events.",
      venue: "Main Quad",
      startsAt: instant(-12, 5),
      endsAt: instant(-12, 10),
      capacity: 150,
    }),
    { publishDay: -22, registrations: 18, members: 9, paid: 0, eventDay: -12, attended: 15 },
  );
  await ledger(-12, treasurer, { type: "income", category: "fundraiser", amountCents: 840000, status: "settled", description: "Bake sale table takings (cash and UPI)", method: "cash", eventId: bakeSale.id });
  await ledger(-14, treasurer, { type: "expense", category: "supplies", amountCents: 215000, status: "settled", description: "Flour, butter, sugar and packaging", counterparty: "FreshMart", eventId: bakeSale.id });
  await ledger(-11, treasurer, { type: "expense", category: "reimbursement", amountCents: 64000, status: "pending", description: "Extra baking trays and parchment (receipt #231)", counterparty: "Meera Iyer", eventId: bakeSale.id });

  const hackNight = await run(
    event({
      title: "Hack Night: Build with AI",
      description: "Bring a laptop and an idea. Mentors on hand, pizza at midnight, demos at the end.",
      venue: "Computer Science Lab 2",
      startsAt: instant(6, 12),
      endsAt: instant(6, 18),
      capacity: 40,
      priceCents: 10000,
      memberPriceCents: 5000,
    }),
    { publishDay: -10, registrations: 37, members: 12, paid: 30, eventDay: 6 },
  );
  await ledger(-8, treasurer, { type: "income", category: "sponsorship", amountCents: 400000, status: "settled", description: "DevTools Inc. sponsorship for Hack Night", counterparty: "DevTools Inc.", eventId: hackNight.id });
  await ledger(-1, treasurer, { type: "expense", category: "catering", amountCents: 350000, status: "pending", description: "Pizza pre-order for 40 (quote #88)", counterparty: "Slice House", eventId: hackNight.id });

  const gala = await run(
    event({
      title: "Winter Gala 2026",
      description: "The biggest night of the year: dinner, awards for the outgoing committee, and a dance floor.",
      venue: "Grand Ballroom, Orchid Hotel",
      startsAt: instant(21, 13),
      endsAt: instant(21, 18),
      capacity: 120,
      priceCents: 60000,
      memberPriceCents: 45000,
      profitTargetCents: 2000000,
    }),
    { publishDay: -18, registrations: 64, members: 19, paid: 41, eventDay: 21 },
  );
  await ledger(-16, treasurer, { type: "income", category: "sponsorship", amountCents: 1000000, status: "settled", description: "Orchid Hotel partnership contribution", counterparty: "Orchid Hotel", eventId: gala.id });
  await ledger(-15, treasurer, { type: "expense", category: "venue", amountCents: 1800000, status: "settled", description: "Ballroom deposit", counterparty: "Orchid Hotel", eventId: gala.id });
  await ledger(-6, treasurer, { type: "expense", category: "marketing", amountCents: 350000, status: "settled", description: "Posters, banners and wristbands", counterparty: "PrintWorks", eventId: gala.id });
  await ledger(-4, treasurer, { type: "expense", category: "catering", amountCents: 2400000, status: "pending", description: "Dinner for 120, balance due on the night", counterparty: "Orchid Hotel", eventId: gala.id });
  await ledger(-2, treasurer, { type: "expense", category: "equipment", amountCents: 900000, status: "pending", description: "DJ, sound and lighting", counterparty: "Decibel Rentals", eventId: gala.id });

  await at(-1, () =>
    createEvent(
      event({
        title: "Alumni Career Panel",
        description: "Four alumni talk about their first jobs and take questions. Draft: speakers to be confirmed.",
        venue: "Lecture Theatre 1",
        startsAt: instant(40, 11),
        endsAt: instant(40, 13),
        capacity: 100,
      }),
      organizer,
    ),
  );

  // --- money not tied to an event -------------------------------------------
  await ledger(-75, treasurer, { type: "income", category: "other_income", amountCents: 3000000, status: "settled", description: "Opening balance carried forward from last year" });
  await ledger(-50, treasurer, { type: "income", category: "donation", amountCents: 500000, status: "settled", description: "Alumni association donation", counterparty: "Skyline Alumni Association" });
  await ledger(-48, treasurer, { type: "expense", category: "merchandise_stock", amountCents: 2600000, status: "settled", description: "Hoodies and T-shirts, first print run", counterparty: "ThreadLab" });
  await ledger(-30, treasurer, { type: "expense", category: "marketing", amountCents: 185000, status: "settled", description: "Flyers for membership drive", counterparty: "PrintWorks" });
  await ledger(-9, treasurer, { type: "expense", category: "other_expense", amountCents: 120000, status: "settled", description: "Website domain and hosting renewal", counterparty: "HostHub" });

  // --- volunteer tasks -------------------------------------------------------
  // Volunteers who are members get the task on their own account; committee names stay as text.
  const memberIdByName = new Map((await listMembers()).map((m) => [m.name, m.id]));
  const task = (title: string, assignee: string | null, due: number | null, status: "todo" | "in_progress" | "done", eventId: string | null, description = "") =>
    at(-7, async () => {
      const created = await createTask(
        { title, description, assignee, assigneeMemberId: (assignee && memberIdByName.get(assignee)) || null, dueOn: due === null ? null : day(due), eventId, volunteerSlots: 0 },
        organizer,
      );
      // Status only moves one step at a time, for seeded tasks as for everyone else.
      if (status !== "todo") await transitionTask(created.id, "start", organizer);
      if (status === "done") await transitionTask(created.id, "done", organizer);
    });
  await task("Run the welcome desk at Hack Night", "Ananya Rao", 6, "todo", hackNight.id, "Hand out name tags and point people to Lab 2.");
  await task("Collect RSVPs from first-year reps", "Ananya Rao", 2, "in_progress", gala.id);
  await task("Book DJ and sound system", "Kabir Shah", -2, "todo", gala.id, "Get a written quote and confirm load-in time with the hotel.");
  await task("Design and print gala posters", "Isha Kapoor", -5, "in_progress", gala.id);
  await task("Collect sponsor logo files", null, -1, "todo", gala.id, "Needed for the stage backdrop.");
  await task("Confirm catering menu and headcount", "Meera Iyer", 5, "in_progress", gala.id);
  await task("Arrange volunteer shifts for the door", "Rohan Das", 14, "todo", gala.id);
  await task("Order pizza for Hack Night", "Dev Malhotra", 4, "todo", hackNight.id);
  await task("Set up Wi-Fi and power strips in Lab 2", "Arjun Reddy", 5, "todo", hackNight.id);
  await task("Bake 200 cookies", "Ananya Rao", -13, "done", bakeSale.id);
  await task("Buy baking supplies", "Meera Iyer", -15, "done", bakeSale.id);
  await task("Run the sale table", "Tara Menon", -12, "done", bakeSale.id);
  await task("Submit semester budget report to Student Affairs", "Priya Nair", 20, "todo", null);

  // --- announcements ---------------------------------------------------------
  await at(-18, () => createAnnouncement({ title: "Winter Gala tickets are on sale", body: "Tickets for the Winter Gala are now live. Members pay the member price when they enter their member number at checkout. Seats are limited to 120.", audience: "everyone" }, organizer));
  await at(-9, () => createAnnouncement({ title: "Bake sale raised ₹8,400. Thank you!", body: "Thanks to everyone who baked, bought and volunteered. The money goes straight into this semester's events budget.", audience: "everyone" }, admin));
  await at(-2, () => createAnnouncement({ title: "General meeting: Thursday 5 pm, Room 204", body: "Agenda: gala logistics, volunteer shifts, and nominations for next year's committee. Members only.", audience: "members" }, admin));

  // --- merchandise -----------------------------------------------------------
  const hoodie = await at(-45, () =>
    createProduct(
      {
        name: "Skyline Hoodie",
        category: "apparel",
        description: "Heavyweight navy hoodie with the embroidered skyline crest.",
        priceCents: 120000,
        memberPriceCents: 100000,
        active: true,
        variants: [{ size: "S", stock: 8 }, { size: "M", stock: 9 }, { size: "L", stock: 5 }, { size: "XL", stock: 6 }],
      },
      treasurer,
    ),
  );
  const tee = await at(-45, () =>
    createProduct(
      {
        name: "Club T-Shirt",
        category: "apparel",
        description: "Soft cotton tee in sky blue. Runs true to size.",
        priceCents: 45000,
        memberPriceCents: 38000,
        active: true,
        variants: [{ size: "S", stock: 15 }, { size: "M", stock: 20 }, { size: "L", stock: 14 }, { size: "XL", stock: 6 }],
      },
      treasurer,
    ),
  );
  const size = (p: typeof hoodie, s: string) => p.variants.find((v) => v.size === s)!.id;
  const orders: [typeof hoodie, string, number, number][] = [
    [hoodie, "L", 1, 0], [hoodie, "L", 2, 1], [hoodie, "L", 1, 2], [hoodie, "L", 1, 3],
    [hoodie, "M", 2, 4], [hoodie, "M", 1, 5], [hoodie, "M", 2, 6], [hoodie, "M", 1, 7],
    [hoodie, "S", 1, 8], [tee, "M", 2, 9], [tee, "L", 1, 10], [tee, "S", 3, 11], [tee, "XL", 2, 12],
  ];
  for (const [product, s, quantity, i] of orders) {
    const member = activeMembers[i % activeMembers.length];
    await at(-40 + i * 3, () =>
      placeOrder({ productId: product.id, variantId: size(product, s), quantity, name: member.name, email: member.email, memberNo: member.memberNo }),
    );
  }
  // Most orders have been paid and handed over; the newest are still open.
  for (const [i, order] of (await listOrders()).reverse().entries()) {
    if (i < 10) await at(-38 + i * 3, () => actOnOrder(order.id, "pay", method(), treasurer));
    if (i < 8) await at(-37 + i * 3, () => actOnOrder(order.id, "fulfil", "cash", treasurer));
  }

  setClock(null);
  let tickets = 0;
  for (const e of [mixer, openMic, bakeSale, hackNight, gala]) tickets += (await listEventTickets(e.id)).length;
  return {
    users: await countUsers(),
    members: MEMBER_NAMES.length,
    events: 6,
    tickets,
    orders: orders.length,
  };
}

/**
 * Whether this process may hold the demo data at all: only a local SQLite
 * database outside production. A PostgreSQL database never gets demo accounts,
 * whose password is published in this file.
 */
export async function demoDataAllowed(): Promise<boolean> {
  return process.env.NODE_ENV !== "production" && (await dbKind()) === "sqlite";
}

/**
 * Development convenience: a fresh checkout has something to look at without
 * a manual step. Never runs in production, where accounts with a published
 * password would be a hole.
 */
export async function seedIfEmptyInDevelopment(): Promise<void> {
  if (!(await demoDataAllowed())) return;
  if (process.env.SKYLINE_AUTO_SEED === "0") return;
  if (await countUsers() > 0) return;
  await seedDemoData();
}
