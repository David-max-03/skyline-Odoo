import {
  eventInputSchema,
  type EventInput,
  type PaymentMethod,
  type SessionUser,
  type TransactionInput,
} from "@/lib/contracts";
import { addDays, ymdInTz } from "@/lib/dates";
import { countUsers, createUser } from "./auth";
import { setClock, wipeAllData } from "./db";
import { createAnnouncement } from "./services/announcements";
import { createEvent, setEventStatus } from "./services/events";
import { createTransaction } from "./services/finance";
import { createMember, joinAsMember, listMembers } from "./services/members";
import { actOnOrder, createProduct, listOrders, placeOrder } from "./services/merch";
import { createTask } from "./services/tasks";
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

export const DEMO_ACCOUNTS = [
  { email: "president@skyline.club", name: "Aarav Mehta", role: "admin" },
  { email: "treasurer@skyline.club", name: "Priya Nair", role: "treasurer" },
  { email: "events@skyline.club", name: "Rohan Das", role: "organizer" },
] as const;

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

export function seedDemoData(): SeedSummary {
  const base = new Date();
  const rand = mulberry32(20261010);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const method = (): PaymentMethod => (rand() < 0.65 ? "upi" : "cash");

  /** Runs `fn` as if it were `days` days from now. */
  const at = <T,>(days: number, fn: () => T): T => {
    setClock(() => new Date(base.getTime() + days * 86_400_000));
    try {
      return fn();
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

  wipeAllData();

  const [admin, treasurer, organizer] = DEMO_ACCOUNTS.map((a) =>
    createUser({ ...a, password: DEMO_PASSWORD }),
  ) as [SessionUser, SessionUser, SessionUser];

  // --- members ---------------------------------------------------------------
  MEMBER_NAMES.forEach((name, i) => {
    const input = {
      name,
      email: emailOf(name),
      studentId: `SKY${2023 + (i % 3)}${String(100 + i * 7).padStart(4, "0")}`,
      phone: null,
      method: method(),
    };
    if (i < 16) {
      // Paid annual members who joined over the last two months.
      at(-70 + i * 3, () => createMember({ ...input, duesPaid: true, expiresOn: null }, treasurer));
    } else if (i < 19) {
      // Semester passes that end soon: these drive the renewal reminders.
      at(-60, () => createMember({ ...input, duesPaid: true, expiresOn: day([9, 16, 24][i - 16]) }, treasurer));
    } else if (i < 21) {
      // Lapsed: the paid term ended a few weeks ago.
      at(-200, () => createMember({ ...input, duesPaid: true, expiresOn: day([-15, -40][i - 19]) }, treasurer));
    } else {
      // Signed up at the campus table; dues not collected yet.
      at(-3 + (i - 21), () => joinAsMember({ name, email: input.email, studentId: input.studentId, phone: null }));
    }
  });
  const activeMembers = listMembers().filter((m) => m.status === "active" || m.status === "expiring");

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
  function run(
    input: EventInput,
    plan: { publishDay: number; registrations: number; members: number; paid: number; eventDay: number; attended?: number },
  ) {
    const created = at(plan.publishDay - 2, () => createEvent(input, organizer));
    at(plan.publishDay, () => setEventStatus(created.id, "published", organizer));
    for (let i = 0; i < plan.registrations; i++) {
      const member = i < plan.members ? activeMembers[i % activeMembers.length] : null;
      const who = member
        ? { name: member.name, email: member.email, studentId: member.studentId, memberNo: member.memberNo }
        : guest();
      const span = Math.max(1, plan.eventDay - plan.publishDay - 1);
      const registerDay = Math.min(plan.publishDay + 1 + Math.floor(rand() * span), -0.01);
      const payNow = i < plan.paid && input.priceCents > 0 ? method() : null;
      at(registerDay, () => registerForEvent(created.id, who, { actor: organizer, payNow }));
    }
    if (plan.attended !== undefined) {
      const tickets = listEventTickets(created.id).reverse();
      at(plan.eventDay + 0.02, () => {
        tickets.slice(0, plan.attended).forEach((t) => {
          // People who had not paid settle at the door, as happens in real life.
          checkIn({ code: t.code, eventId: created.id, collectPayment: true, method: "cash" }, organizer);
        });
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

  const mixer = run(
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
  ledger(-42, treasurer, { type: "income", category: "sponsorship", amountCents: 500000, status: "settled", description: "Campus Café sponsorship for the mixer", counterparty: "Campus Café", eventId: mixer.id });
  ledger(-38, treasurer, { type: "expense", category: "venue", amountCents: 300000, status: "settled", description: "Hall B booking fee", counterparty: "Student Centre", eventId: mixer.id });
  ledger(-35, treasurer, { type: "expense", category: "catering", amountCents: 650000, status: "settled", description: "Snacks and soft drinks for 80", counterparty: "Tiffin Box Caterers", eventId: mixer.id });
  ledger(-34, organizer, { type: "expense", category: "supplies", amountCents: 120000, status: "pending", description: "Balloons, name tags and fairy lights (receipt #214)", counterparty: "Rohan Das", eventId: mixer.id });

  const openMic = run(
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
  ledger(-21, treasurer, { type: "expense", category: "equipment", amountCents: 450000, status: "settled", description: "Sound system and stage lights hire", counterparty: "Decibel Rentals", eventId: openMic.id });

  const bakeSale = run(
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
  ledger(-12, treasurer, { type: "income", category: "fundraiser", amountCents: 840000, status: "settled", description: "Bake sale table takings (cash and UPI)", method: "cash", eventId: bakeSale.id });
  ledger(-14, treasurer, { type: "expense", category: "supplies", amountCents: 215000, status: "settled", description: "Flour, butter, sugar and packaging", counterparty: "FreshMart", eventId: bakeSale.id });
  ledger(-11, organizer, { type: "expense", category: "reimbursement", amountCents: 64000, status: "pending", description: "Extra baking trays and parchment (receipt #231)", counterparty: "Meera Iyer", eventId: bakeSale.id });

  const hackNight = run(
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
  ledger(-8, treasurer, { type: "income", category: "sponsorship", amountCents: 400000, status: "settled", description: "DevTools Inc. sponsorship for Hack Night", counterparty: "DevTools Inc.", eventId: hackNight.id });
  ledger(-1, organizer, { type: "expense", category: "catering", amountCents: 350000, status: "pending", description: "Pizza pre-order for 40 (quote #88)", counterparty: "Slice House", eventId: hackNight.id });

  const gala = run(
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
  ledger(-16, treasurer, { type: "income", category: "sponsorship", amountCents: 1000000, status: "settled", description: "Orchid Hotel partnership contribution", counterparty: "Orchid Hotel", eventId: gala.id });
  ledger(-15, treasurer, { type: "expense", category: "venue", amountCents: 1800000, status: "settled", description: "Ballroom deposit", counterparty: "Orchid Hotel", eventId: gala.id });
  ledger(-6, treasurer, { type: "expense", category: "marketing", amountCents: 350000, status: "settled", description: "Posters, banners and wristbands", counterparty: "PrintWorks", eventId: gala.id });
  ledger(-4, organizer, { type: "expense", category: "catering", amountCents: 2400000, status: "pending", description: "Dinner for 120, balance due on the night", counterparty: "Orchid Hotel", eventId: gala.id });
  ledger(-2, organizer, { type: "expense", category: "equipment", amountCents: 900000, status: "pending", description: "DJ, sound and lighting", counterparty: "Decibel Rentals", eventId: gala.id });

  at(-1, () =>
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
  ledger(-75, treasurer, { type: "income", category: "other_income", amountCents: 3000000, status: "settled", description: "Opening balance carried forward from last year" });
  ledger(-50, treasurer, { type: "income", category: "donation", amountCents: 500000, status: "settled", description: "Alumni association donation", counterparty: "Skyline Alumni Association" });
  ledger(-48, treasurer, { type: "expense", category: "merchandise_stock", amountCents: 2600000, status: "settled", description: "Hoodies and T-shirts, first print run", counterparty: "ThreadLab" });
  ledger(-30, treasurer, { type: "expense", category: "marketing", amountCents: 185000, status: "settled", description: "Flyers for membership drive", counterparty: "PrintWorks" });
  ledger(-9, treasurer, { type: "expense", category: "other_expense", amountCents: 120000, status: "settled", description: "Website domain and hosting renewal", counterparty: "HostHub" });

  // --- volunteer tasks -------------------------------------------------------
  const task = (title: string, assignee: string | null, due: number | null, status: "todo" | "in_progress" | "done", eventId: string | null, description = "") =>
    at(-7, () => createTask({ title, description, assignee, dueOn: due === null ? null : day(due), status, eventId }, organizer));
  task("Book DJ and sound system", "Kabir Shah", -2, "todo", gala.id, "Get a written quote and confirm load-in time with the hotel.");
  task("Design and print gala posters", "Isha Kapoor", -5, "in_progress", gala.id);
  task("Collect sponsor logo files", null, -1, "todo", gala.id, "Needed for the stage backdrop.");
  task("Confirm catering menu and headcount", "Meera Iyer", 5, "in_progress", gala.id);
  task("Arrange volunteer shifts for the door", "Rohan Das", 14, "todo", gala.id);
  task("Order pizza for Hack Night", "Dev Malhotra", 4, "todo", hackNight.id);
  task("Set up Wi-Fi and power strips in Lab 2", "Arjun Reddy", 5, "todo", hackNight.id);
  task("Bake 200 cookies", "Ananya Rao", -13, "done", bakeSale.id);
  task("Buy baking supplies", "Meera Iyer", -15, "done", bakeSale.id);
  task("Run the sale table", "Tara Menon", -12, "done", bakeSale.id);
  task("Submit semester budget report to Student Affairs", "Priya Nair", 20, "todo", null);

  // --- announcements ---------------------------------------------------------
  at(-18, () => createAnnouncement({ title: "Winter Gala tickets are on sale", body: "Tickets for the Winter Gala are now live. Members pay the member price when they enter their member number at checkout. Seats are limited to 120.", audience: "everyone" }, organizer));
  at(-9, () => createAnnouncement({ title: "Bake sale raised ₹8,400. Thank you!", body: "Thanks to everyone who baked, bought and volunteered. The money goes straight into this semester's events budget.", audience: "everyone" }, admin));
  at(-2, () => createAnnouncement({ title: "General meeting: Thursday 5 pm, Room 204", body: "Agenda: gala logistics, volunteer shifts, and nominations for next year's committee. Members only.", audience: "members" }, admin));

  // --- merchandise -----------------------------------------------------------
  const hoodie = at(-45, () =>
    createProduct(
      {
        name: "Skyline Hoodie",
        description: "Heavyweight navy hoodie with the embroidered skyline crest.",
        priceCents: 120000,
        memberPriceCents: 100000,
        active: true,
        variants: [{ size: "S", stock: 8 }, { size: "M", stock: 9 }, { size: "L", stock: 5 }, { size: "XL", stock: 6 }],
      },
      treasurer,
    ),
  );
  const tee = at(-45, () =>
    createProduct(
      {
        name: "Club T-Shirt",
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
  orders.forEach(([product, s, quantity, i]) => {
    const member = activeMembers[i % activeMembers.length];
    at(-40 + i * 3, () =>
      placeOrder({ productId: product.id, variantId: size(product, s), quantity, name: member.name, email: member.email, memberNo: member.memberNo }),
    );
  });
  // Most orders have been paid and handed over; the newest are still open.
  listOrders()
    .reverse()
    .forEach((order, i) => {
      if (i < 10) at(-38 + i * 3, () => actOnOrder(order.id, "pay", method(), treasurer));
      if (i < 8) at(-37 + i * 3, () => actOnOrder(order.id, "fulfil", "cash", treasurer));
    });

  setClock(null);
  return {
    users: countUsers(),
    members: MEMBER_NAMES.length,
    events: 6,
    tickets: [mixer, openMic, bakeSale, hackNight, gala].reduce((n, e) => n + listEventTickets(e.id).length, 0),
    orders: orders.length,
  };
}

/**
 * Development convenience: a fresh checkout has something to look at without
 * a manual step. Never runs in production, where accounts with a published
 * password would be a hole.
 */
export function seedIfEmptyInDevelopment(): void {
  if (process.env.NODE_ENV === "production") return;
  if (process.env.SKYLINE_AUTO_SEED === "0") return;
  if (countUsers() > 0) return;
  seedDemoData();
}
