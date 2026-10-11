/**
 * End-to-end check over HTTP against the production build.
 *
 *   npm run build && npm run e2e
 *
 * Starts `next start` on a temporary database (a SQLite file, or with
 * `npm run e2e:pg` a disposable PostgreSQL server), drives the real API the way
 * the UI does, restarts the server to prove the data persisted, and exits
 * non-zero on the first failed assertion. Nothing here touches data/skyline.db.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- responses are untyped JSON here on purpose; each field used is asserted */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUser } from "../src/server/auth";
import { closeDb } from "../src/server/db";

const PORT = Number(process.env.E2E_PORT ?? 3217);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "..");
const PASSWORD = "e2e-password-1";
/** Set by `scripts/with-postgres.ts`: run against its disposable PostgreSQL instead of a temporary SQLite file. */
const ON_POSTGRES = process.env.SKYLINE_TEST_DB === "postgres";

// A stand-in for Razorpay's API on this machine. The keys are made up; the
// server under test is pointed here, so no request ever reaches Razorpay.
const FAKE_RAZORPAY_PORT = PORT + 1;
const RAZORPAY_KEY_ID = "rzp_test_E2eCheckKey0001";
const RAZORPAY_KEY_SECRET = "e2e-key-secret-not-real";
const RAZORPAY_WEBHOOK_SECRET = "e2e-webhook-secret-not-real";

interface FakePayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  method: string;
}
const fakeRazorpay = {
  server: null as http.Server | null,
  orders: new Map<string, { id: string; amount: number; currency: string; status: string }>(),
  payments: new Map<string, FakePayment>(),
  counter: 0,
  unauthenticated: 0,
  nextId(prefix: string): string {
    return `${prefix}_E2e${String(++this.counter).padStart(10, "0")}`;
  },
  /** Records a payment the way Razorpay would after the applicant pays an order. */
  pay(orderId: string, overrides: Partial<FakePayment> = {}): FakePayment {
    const order = this.orders.get(orderId);
    assert.ok(order, `the fake has no order ${orderId}`);
    const payment = { id: this.nextId("pay"), order_id: orderId, amount: order.amount, currency: order.currency, status: "captured", method: "upi", ...overrides };
    this.payments.set(payment.id, payment);
    return payment;
  },
  start(): Promise<void> {
    const expected = `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64")}`;
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.headers.authorization !== expected) {
          this.unauthenticated += 1;
          return send(401, { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } });
        }
        const url = req.url ?? "";
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        let match: RegExpMatchArray | null;
        if (req.method === "POST" && url === "/v1/orders") {
          const order = { id: this.nextId("order"), amount: body.amount, currency: body.currency, status: "created" };
          this.orders.set(order.id, order);
          return send(200, { ...order, entity: "order", receipt: body.receipt });
        }
        if (req.method === "GET" && (match = url.match(/^\/v1\/orders\/(order_\w+)\/payments$/))) {
          return send(200, { entity: "collection", items: [...this.payments.values()].filter((p) => p.order_id === match![1]) });
        }
        if (req.method === "GET" && (match = url.match(/^\/v1\/payments\/(pay_\w+)$/))) {
          const payment = this.payments.get(match[1]);
          return payment ? send(200, payment) : send(400, { error: { code: "BAD_REQUEST_ERROR" } });
        }
        return send(404, { error: { code: "NOT_FOUND" } });
      });
    });
    return new Promise((resolve) => this.server!.listen(FAKE_RAZORPAY_PORT, "127.0.0.1", () => resolve()));
  },
  stop(): void {
    this.server?.close();
    this.server = null;
  },
};

const signHex = (secret: string, message: string) => createHmac("sha256", secret).update(message).digest("hex");

/** Delivers a webhook the way Razorpay does: a raw JSON body, signed, with an event id. */
async function deliverWebhook(type: string, payment: FakePayment, eventId: string, secret = RAZORPAY_WEBHOOK_SECRET) {
  const body = JSON.stringify({ entity: "event", event: type, payload: { payment: { entity: payment } } });
  const response = await fetch(`${BASE}/api/webhooks/razorpay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Razorpay-Signature": signHex(secret, body), "x-razorpay-event-id": eventId },
    body,
  });
  return { status: response.status, body: (await response.json()) as any };
}

interface Reply<T = any> {
  status: number;
  data: T;
  error: { code: string; message: string; fields?: Record<string, string> } | null;
}

/** A browser-like client: remembers the session cookie between calls. */
class Client {
  private cookie = "";
  constructor(private readonly headers: Record<string, string> = {}) {}

  async call<T = any>(method: string, route: string, body?: unknown): Promise<Reply<T>> {
    const response = await fetch(BASE + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...this.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    const payload = (await response.json().catch(() => ({}))) as { data?: T; error?: Reply["error"] };
    return { status: response.status, data: payload.data as T, error: payload.error ?? null };
  }
  get = <T = any>(route: string) => this.call<T>("GET", route);
  post = <T = any>(route: string, body: unknown = {}) => this.call<T>("POST", route, body);
  patch = <T = any>(route: string, body: unknown) => this.call<T>("PATCH", route, body);

  private auth(): Record<string, string> {
    return { ...(this.cookie ? { Cookie: this.cookie } : {}), ...this.headers };
  }

  /** Posts a multipart form, optionally with one file, the way the browser does for uploads. */
  async form<T = any>(
    route: string,
    fields: Record<string, string>,
    file?: { field: string; bytes: Uint8Array<ArrayBuffer>; type: string; name: string },
  ): Promise<Reply<T>> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    if (file) form.set(file.field, new Blob([file.bytes], { type: file.type }), file.name);
    const response = await fetch(BASE + route, { method: "POST", headers: this.auth(), body: form, redirect: "manual" });
    const payload = (await response.json().catch(() => ({}))) as { data?: T; error?: Reply["error"] };
    return { status: response.status, data: payload.data as T, error: payload.error ?? null };
  }

  /** A GET that returns the raw response, for endpoints that do not answer with JSON. */
  raw(route: string): Promise<Response> {
    return fetch(BASE + route, { headers: this.auth(), redirect: "manual" });
  }

  async signIn(email: string): Promise<this> {
    const reply = await this.post("/api/auth/login", { email, password: PASSWORD });
    assert.equal(reply.status, 200, `sign-in failed for ${email}`);
    return this;
  }
}

let server: ChildProcess | null = null;

async function startServer(dbPath: string): Promise<void> {
  server = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      // A production build only uses SQLite when told to; under `npm run e2e:pg` the
      // disposable PostgreSQL server's DATABASE_URL is already in the environment.
      ...(ON_POSTGRES ? {} : { SKYLINE_DB_DRIVER: "sqlite", SKYLINE_DB_PATH: dbPath }),
      SKYLINE_UPLOAD_DIR: path.join(path.dirname(dbPath), "uploads"),
      SKYLINE_DISABLE_RATE_LIMIT: "1",
      // Set here so nothing in a local .env file can point this run at the real Razorpay.
      SKYLINE_RAZORPAY_MODE: "test",
      SKYLINE_RAZORPAY_KEY_ID: RAZORPAY_KEY_ID,
      SKYLINE_RAZORPAY_KEY_SECRET: RAZORPAY_KEY_SECRET,
      SKYLINE_RAZORPAY_WEBHOOK_SECRET: RAZORPAY_WEBHOOK_SECRET,
      SKYLINE_RAZORPAY_API_BASE: `http://127.0.0.1:${FAKE_RAZORPAY_PORT}/v1`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout?.on("data", (chunk) => (output += chunk));
  server.stderr?.on("data", (chunk) => (output += chunk));
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    try {
      if ((await fetch(`${BASE}/api/auth/me`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start within 20 seconds:\n${output}`);
}

async function stopServer(): Promise<void> {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 4000).unref();
  });
}

let passed = 0;
function ok(description: string): void {
  passed += 1;
  console.log(`  ✓ ${description}`);
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    throw new Error("No production build found. Run `npm run build` first.");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skyline-e2e-"));
  const dbPath = path.join(dir, "e2e.db");

  if (ON_POSTGRES) {
    // Only ever the throwaway server started by scripts/with-postgres.ts.
    if (!/@127\.0\.0\.1:\d+\/skyline_test$/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("Refusing to run: DATABASE_URL is not the disposable local test database.");
    }
  } else {
    process.env.SKYLINE_DB_PATH = dbPath;
  }
  // Accounts are created directly, as an administrator would with the admin command.
  await createUser({ email: "admin@e2e.example", name: "Asha Admin", role: "admin", password: PASSWORD });
  await createUser({ email: "treasurer@e2e.example", name: "Tariq Treasurer", role: "treasurer", password: PASSWORD });
  await createUser({ email: "organizer@e2e.example", name: "Omar Organizer", role: "organizer", password: PASSWORD });
  // A second organizer whose account the president disables later on.
  await createUser({ email: "leaver@e2e.example", name: "Lena Leaver", role: "organizer", password: PASSWORD });
  await closeDb();

  console.log(`Skyline end-to-end check\n  database: ${ON_POSTGRES ? "disposable PostgreSQL (127.0.0.1)" : dbPath}\n  server:   ${BASE}\n`);
  await fakeRazorpay.start();
  await startServer(dbPath);

  const anon = new Client();
  const organizer = await new Client().signIn("organizer@e2e.example");
  const treasurer = await new Client().signIn("treasurer@e2e.example");

  // --- the database behind the server ------------------------------------------
  const health = await anon.get("/api/health");
  assert.equal(health.status, 200, JSON.stringify(health.error));
  assert.equal(health.data.database, ON_POSTGRES ? "postgres" : "sqlite");
  assert.deepEqual(Object.keys(health.data).sort(), ["database", "status"]);
  ok(`the health check reports a working ${health.data.database} database and nothing else`);

  // --- access control ---------------------------------------------------------
  console.log("Access control");
  assert.equal((await anon.get("/api/dashboard")).status, 401);
  assert.equal((await anon.get("/api/members")).status, 401);
  assert.equal((await anon.post("/api/events", {})).status, 401);
  assert.equal((await anon.post("/api/tickets/check-in", { code: "SKY-22222-22222" })).status, 401);
  ok("anonymous calls to staff endpoints are rejected with 401");
  assert.equal((await anon.post("/api/auth/login", { email: "admin@e2e.example", password: "wrong-password" })).status, 401);
  ok("a wrong password is rejected");
  const page = await fetch(`${BASE}/org/finance`, { redirect: "manual" });
  assert.equal(page.status, 307);
  assert.match(page.headers.get("location") ?? "", /\/login\?next=/);
  ok("staff pages redirect to sign-in without a session");
  const forged = new Client({ Cookie: "skyline_session=forged-token" });
  assert.equal((await forged.get("/api/dashboard")).status, 401);
  ok("a forged session cookie is rejected");

  // --- 1. create an event -----------------------------------------------------
  console.log("Events");
  const start = new Date(Date.now() + 2 * 86_400_000);
  const end = new Date(start.getTime() + 3 * 3_600_000);
  const eventBody = {
    title: "E2E Spring Gala",
    description: "Created by the end-to-end check.",
    venue: "Main Hall",
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    capacity: 5,
    priceCents: 50000,
    memberPriceCents: 40000,
    profitTargetCents: 100000,
  };
  const invalid = await organizer.post("/api/events", { ...eventBody, capacity: 0, endsAt: start.toISOString() });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.error?.fields?.capacity && invalid.error.fields.endsAt);
  ok("invalid event input is rejected with field errors");
  assert.equal((await treasurer.post("/api/events", eventBody)).status, 403);
  ok("a treasurer cannot create events (403)");
  const created = await organizer.post("/api/events", eventBody);
  assert.equal(created.status, 200);
  assert.equal(created.data.status, "draft");
  const eventId: string = created.data.id;
  ok("an organizer creates an event as a draft");
  assert.equal((await anon.get(`/api/public/events/${eventId}`)).status, 404);
  assert.equal((await anon.post(`/api/public/events/${eventId}/register`, { name: "Early Bird", email: "early@e2e.example" })).status, 404);
  ok("a draft is invisible to the public and cannot be registered for");
  assert.equal((await organizer.post(`/api/events/${eventId}/status`, { status: "published" })).data.event.status, "published");
  assert.equal((await anon.get("/api/public/events")).data.length, 1);
  ok("publishing lists the event publicly");

  // --- 2 & 3. register a student, get a ticket ----------------------------------
  console.log("Registration and tickets");
  const bad = await anon.post(`/api/public/events/${eventId}/register`, { name: "", email: "not-an-email" });
  assert.equal(bad.status, 422);
  ok("registration input is validated");
  const reg = await anon.post(`/api/public/events/${eventId}/register`, { name: "Riya Sharma", email: "riya@e2e.example" });
  assert.equal(reg.status, 200);
  assert.match(reg.data.code, /^SKY-[2-9A-Z]{5}-[2-9A-Z]{5}$/);
  assert.equal(reg.data.paymentStatus, "pending");
  const code: string = reg.data.code;
  ok(`a student registers and receives ticket ${code}`);
  const ticket = await anon.get(`/api/public/tickets/${code}`);
  assert.equal(ticket.status, 200);
  assert.ok(ticket.data.qrSvg.includes("<svg"));
  assert.ok(!JSON.stringify(ticket.data).includes("riya@e2e.example"));
  ok("the public ticket has a QR code and does not expose the email");
  assert.equal((await anon.post(`/api/public/events/${eventId}/register`, { name: "Riya Again", email: "RIYA@e2e.example" })).error?.code, "already_registered");
  ok("a second ticket for the same email is refused");

  // --- capacity under concurrency ------------------------------------------------
  const rush = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      new Client().post(`/api/public/events/${eventId}/register`, { name: `Rush ${i}`, email: `rush${i}@e2e.example` }),
    ),
  );
  const won = rush.filter((r) => r.status === 200);
  const lost = rush.filter((r) => r.error?.code === "sold_out");
  assert.equal(won.length, 4, "exactly the 4 remaining seats should be filled");
  assert.equal(lost.length, 8);
  const full = await organizer.get(`/api/events/${eventId}`);
  assert.equal(full.data.event.stats.registered, 5);
  assert.equal(full.data.event.stats.remaining, 0);
  ok("12 simultaneous registrations for 4 seats: 4 succeed, 8 are told it is full");
  assert.equal((await organizer.patch(`/api/events/${eventId}`, { ...eventBody, capacity: 3 })).status, 422);
  ok("capacity cannot be edited below the number registered");

  // --- 4 & 5. verify, check in, reject duplicates ---------------------------------
  console.log("Check-in");
  assert.equal((await anon.post("/api/tickets/verify", { code })).status, 401);
  assert.equal((await organizer.post("/api/tickets/verify", { code })).data.outcome, "payment_required");
  assert.equal((await organizer.post("/api/tickets/check-in", { code, eventId })).data.outcome, "payment_required");
  ok("an unpaid ticket is flagged and not admitted");
  assert.equal((await organizer.post("/api/tickets/check-in", { code, eventId, collectPayment: true, method: "upi" })).status, 403);
  assert.equal((await organizer.post(`/api/tickets/${code}`, { action: "pay", method: "cash" })).status, 403);
  assert.equal((await organizer.post(`/api/events/${eventId}/registrations`, { name: "Desk Payer", email: "desk.payer@campus.example", payNow: "cash" })).status, 403);
  assert.equal((await organizer.post("/api/tickets/verify", { code })).data.outcome, "payment_required");
  ok("an organizer cannot take a ticket payment: not at the door, not on the ticket, not at the desk (403), and the ticket stays unpaid");
  const admitted = await treasurer.post("/api/tickets/check-in", { code: code.toLowerCase().replace(/-/g, " "), eventId, collectPayment: true, method: "upi" });
  assert.equal(admitted.data.outcome, "checked_in");
  assert.equal(admitted.data.ticket.paymentStatus, "paid");
  ok("the treasurer collecting payment at the door admits the holder (code typed loosely)");
  const again = await organizer.post("/api/tickets/check-in", { code, eventId });
  assert.equal(again.data.outcome, "already_checked_in");
  assert.equal(again.data.ticket.checkedInAt, admitted.data.ticket.checkedInAt);
  ok("a second check-in of the same ticket is rejected");
  assert.equal((await organizer.post("/api/tickets/check-in", { code: "SKY-22222-22222", eventId })).data.outcome, "not_found");
  assert.equal((await organizer.post("/api/tickets/check-in", { code: "'; DROP TABLE tickets;--", eventId })).data.outcome, "not_found");
  ok("unknown and malformed codes are rejected");
  const racer = won[0].data.code as string;
  await treasurer.post(`/api/tickets/${racer}`, { action: "pay", method: "cash" });
  const race = await Promise.all(Array.from({ length: 6 }, () => organizer.post("/api/tickets/check-in", { code: racer, eventId })));
  assert.equal(race.filter((r) => r.data.outcome === "checked_in").length, 1);
  assert.equal(race.filter((r) => r.data.outcome === "already_checked_in").length, 5);
  ok("6 simultaneous scans of one ticket: exactly 1 is admitted");
  assert.equal((await organizer.get(`/api/events/${eventId}`)).data.event.stats.checkedIn, 2);
  ok("attendance statistics show 2 checked in");

  // --- 6 & 7. income, expenses and the event's result ------------------------------
  console.log("Finance");
  const today = new Date().toLocaleDateString("en-CA");
  const entry = { occurredOn: today, eventId, counterparty: null, method: null };
  assert.equal((await treasurer.post("/api/transactions", { ...entry, type: "expense", category: "venue", amountCents: -5, status: "settled", description: "Bad" })).status, 422);
  assert.equal((await treasurer.post("/api/transactions", { ...entry, type: "expense", category: "tickets", amountCents: 100, status: "settled", description: "Wrong category" })).status, 422);
  ok("invalid financial records are rejected");
  assert.equal((await organizer.post("/api/transactions", { ...entry, type: "income", category: "sponsorship", amountCents: 100000, status: "settled", description: "Organizer income" })).status, 403);
  ok("an organizer cannot record income (403)");
  assert.equal((await treasurer.post("/api/transactions", { ...entry, type: "income", category: "sponsorship", amountCents: 200000, status: "settled", description: "Sponsor: Campus Café" })).status, 200);
  assert.equal((await treasurer.post("/api/transactions", { ...entry, type: "expense", category: "venue", amountCents: 150000, status: "settled", description: "Hall hire" })).status, 200);
  const owed = { ...entry, type: "expense", category: "reimbursement", amountCents: 30000, status: "pending", description: "Decorations", counterparty: "Omar Organizer" };
  assert.equal((await organizer.post("/api/transactions", owed)).status, 403);
  const claim = await treasurer.post("/api/transactions", owed);
  assert.equal(claim.status, 200);
  assert.equal((await organizer.post(`/api/transactions/${claim.data.id}`, { action: "settle" })).status, 403);
  ok("treasurer records income and expenses; an organizer cannot write to the ledger or settle anything");

  const detail = (await treasurer.get(`/api/events/${eventId}`)).data;
  const f = detail.event.finance;
  // 2 tickets paid (2 × 500) + sponsorship 2,000 collected; 3 tickets (1,500) still to collect.
  assert.deepEqual(
    [f.incomeSettledCents, f.incomePendingCents, f.expenseSettledCents, f.expensePendingCents, f.netCents, f.projectedNetCents],
    [300000, 150000, 150000, 30000, 150000, 270000],
  );
  const ledger: any[] = (await treasurer.get(`/api/transactions?eventId=${eventId}`)).data;
  const sum = (type: string, status: string) =>
    ledger.filter((t) => t.type === type && t.status === status).reduce((s, t) => s + t.amountCents, 0);
  assert.equal(sum("income", "settled"), f.incomeSettledCents);
  assert.equal(sum("income", "pending"), f.incomePendingCents);
  assert.equal(sum("expense", "settled"), f.expenseSettledCents);
  assert.equal(sum("expense", "pending"), f.expensePendingCents);
  ok("event result: collected 3,000 − paid 1,500 = 1,500; pending kept separate; totals equal the ledger rows");
  const summary = (await treasurer.get("/api/finance/summary")).data;
  const dashboard = (await treasurer.get("/api/dashboard")).data;
  assert.equal(summary.netCents, 150000);
  assert.equal(dashboard.finance.netCents, summary.netCents);
  assert.equal(dashboard.tickets.registered, 5);
  assert.equal(dashboard.tickets.checkedIn, 2);
  ok("finance summary and dashboard agree with the event figures");

  // --- 8. event analysis ----------------------------------------------------------
  console.log("Event analysis");
  // Costs 1,800 are fully covered by the 2,000 sponsorship.
  assert.deepEqual(detail.breakEven.toCoverCents, 0);
  assert.equal(detail.breakEven.alreadyCovered, true);
  assert.equal(detail.profitTarget.gapActualCents, 0);
  ok("break-even and profit target on the event page come from the ledger");

  // --- 9. membership applications and member accounts -----------------------------
  console.log("Membership");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const applicant = { name: "Mira Member", email: "mira@e2e.example", paymentMethod: "upi", paymentReference: "UTR 4455 6677" };
  const noProof = await anon.form("/api/public/applications", applicant);
  assert.equal(noProof.status, 422);
  assert.ok(noProof.error?.fields?.evidence);
  const fakeImage = await anon.form("/api/public/applications", applicant, {
    field: "evidence",
    bytes: new TextEncoder().encode("<script>alert(1)</script>"),
    type: "image/png",
    name: "proof.png",
  });
  assert.equal(fakeImage.status, 422);
  ok("an application without a screenshot, or with a file that is not an image, is refused");

  const applied = await anon.form("/api/public/applications", applicant, { field: "evidence", bytes: png, type: "image/png", name: "proof.png" });
  assert.equal(applied.status, 200, JSON.stringify(applied.error));
  assert.equal(applied.data.status, "pending");
  assert.equal((await treasurer.get("/api/members")).data.length, 0);
  assert.equal((await treasurer.get("/api/transactions?category=dues")).data.length, 0);
  assert.equal((await new Client().post("/api/auth/login", { email: "mira@e2e.example", password: "anything-at-all" })).status, 401);
  assert.equal((await anon.post("/api/public/applications/status", { code: applied.data.code, email: "mira@e2e.example" })).data.status, "pending");
  assert.equal((await anon.post("/api/public/applications/status", { code: applied.data.code, email: "other@e2e.example" })).status, 404);
  ok("applying creates a pending application only: no member, no dues in the ledger, no sign-in");

  assert.equal((await anon.get("/api/applications")).status, 401);
  assert.equal((await organizer.get("/api/applications")).status, 403);
  const [pendingApp] = (await treasurer.get("/api/applications")).data;
  const reviewRoute = `/api/applications/${pendingApp.id}`;
  assert.equal((await organizer.post(reviewRoute, { action: "approve", paymentReceived: true })).status, 403);
  assert.equal((await treasurer.post(reviewRoute, { action: "approve" })).status, 422);
  assert.equal((await treasurer.post(reviewRoute, { action: "approve", paymentReceived: false })).status, 422);
  assert.equal((await treasurer.get("/api/members")).data.length, 0);
  ok("only the treasurer or president can review, and approval needs the payment confirmation");

  const fileRoute = `/api/files/${pendingApp.evidenceFileId}`;
  assert.equal((await anon.raw(fileRoute)).status, 401);
  assert.equal((await organizer.raw(fileRoute)).status, 403);
  const image = await treasurer.raw(fileRoute);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.match(image.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  ok("the payment screenshot is served only to reviewers, as an image, uncached");

  const approval = await treasurer.post(reviewRoute, { action: "approve", paymentReceived: true });
  assert.equal(approval.status, 200, JSON.stringify(approval.error));
  const memberNo: string = approval.data.application.memberNo;
  assert.match(memberNo, /^SKY-M-\d{4}$/);
  const dues = (await treasurer.get("/api/transactions?category=dues")).data;
  assert.equal(dues.length, 1);
  assert.equal(dues[0].status, "settled");
  assert.equal(dues[0].amountCents, applied.data.amountCents);
  assert.ok(dues[0].description.includes("UTR44556677"), dues[0].description);
  assert.equal((await treasurer.post(reviewRoute, { action: "approve", paymentReceived: true })).status, 409);
  assert.equal((await treasurer.get("/api/members")).data.length, 1);
  ok("approval creates one member with a member ID and one settled dues entry; a second approval is refused");

  const memberPassword = "e2e-member-password";
  const token: string = approval.data.setup.path.split("/").pop();
  assert.equal((await anon.post("/api/auth/setup/check", { token })).data.memberNo, memberNo);
  assert.equal((await anon.post("/api/auth/setup", { token, password: "short" })).status, 422);
  assert.equal((await new Client().post("/api/auth/login", { email: memberNo, password: "short" })).status, 401);
  assert.equal((await anon.post("/api/auth/setup", { token, password: memberPassword })).status, 200);
  assert.equal((await anon.post("/api/auth/setup", { token, password: "another-long-password" })).status, 400);
  assert.equal((await anon.post("/api/auth/setup/check", { token })).status, 400);
  ok("the setup link sets a password once and then stops working");

  const member = new Client();
  const signedIn = await member.post("/api/auth/login", { email: memberNo, password: memberPassword });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.data.user.role, "member");
  assert.equal((await member.get("/api/auth/me")).data.user.memberNo, memberNo);
  const mine = (await member.get("/api/me")).data;
  assert.equal(mine.memberNo, memberNo);
  assert.equal(mine.status, "active");
  ok("the member signs in with the member ID and sees their own record");

  const memberId: string = approval.data.application.memberId;
  for (const route of ["/api/dashboard", "/api/members", `/api/members/${memberId}`, "/api/transactions", "/api/finance/summary", "/api/orders", "/api/tasks", "/api/applications", "/api/events", `/api/events/${eventId}`]) {
    assert.equal((await member.get(route)).status, 403, `GET ${route}`);
  }
  const forbiddenWrites: [string, unknown][] = [
    ["/api/events", eventBody],
    ["/api/tasks", { title: "Assign this to someone else", assignee: "Someone Else" }],
    ["/api/transactions", { type: "income", category: "donation", amountCents: 100000, occurredOn: "2026-01-01", description: "Self-credit" }],
    ["/api/tickets/check-in", { code }],
    [`/api/events/${eventId}/registrations`, { name: "Desk Sale", email: "desk@e2e.example", payNow: "cash" }],
    ["/api/members", { name: "A Friend", email: "friend@e2e.example", duesPaid: true }],
    [`/api/members/${memberId}/setup-link`, {}],
    [reviewRoute, { action: "approve", paymentReceived: true }],
  ];
  for (const [route, body] of forbiddenWrites) {
    assert.equal((await member.post(route, body)).status, 403, `POST ${route}`);
  }
  assert.equal((await member.raw(fileRoute)).status, 403);
  ok("a member account is refused by every committee endpoint, including creating events and assigning tasks");

  assert.equal((await treasurer.get("/api/me")).status, 403);
  assert.equal((await anon.get("/api/me")).status, 401);
  const memberPage = await fetch(`${BASE}/member`, { redirect: "manual" });
  assert.equal(memberPage.status, 307);
  ok("member endpoints refuse committee accounts and anonymous callers; member pages redirect to sign-in");

  // --- 10. volunteer tasks ----------------------------------------------------------
  console.log("Tasks");
  const taskForMember = (await organizer.post("/api/tasks", { title: "Hang the banner", assigneeMemberId: memberId, status: "done" })).data;
  const taskForStaff = (await organizer.post("/api/tasks", { title: "Book the hall", assignee: "Omar Organizer" })).data;
  assert.equal(taskForMember.status, "todo");
  assert.equal(taskForMember.assignee, "Mira Member");
  assert.equal((await organizer.patch(`/api/tasks/${taskForStaff.id}`, { status: "done" })).status, 422);
  assert.equal((await organizer.patch(`/api/tasks/${taskForStaff.id}`, { action: "done" })).status, 409);
  assert.equal((await organizer.patch(`/api/tasks/${taskForStaff.id}`, { action: "start" })).data.status, "in_progress");
  ok("a task starts in To do, cannot be given a status directly, and only moves one legal step");

  const myTasks = (await member.get("/api/me/tasks")).data;
  assert.deepEqual(myTasks.map((t: any) => t.title), ["Hang the banner"]);
  const mineRoute = `/api/me/tasks/${taskForMember.id}`;
  assert.equal((await member.patch(mineRoute, { action: "reopen" })).status, 409);
  assert.equal((await member.patch(mineRoute, { action: "start" })).data.status, "in_progress");
  assert.equal((await member.patch(mineRoute, { action: "done" })).data.status, "done");
  assert.equal((await member.patch(mineRoute, { action: "reopen" })).data.status, "in_progress");
  ok("a member sees only their own tasks and moves them Start → Done → Reopen (back to In progress)");

  assert.equal((await member.patch(`/api/me/tasks/${taskForStaff.id}`, { action: "done" })).status, 404);
  assert.equal((await member.patch(`/api/tasks/${taskForMember.id}`, { action: "start" })).status, 403);
  assert.equal((await member.call("PUT", `/api/tasks/${taskForMember.id}`, { title: "Hang the banner", assignee: "Someone Else" })).status, 403);
  assert.equal((await member.call("DELETE", `/api/tasks/${taskForMember.id}`)).status, 403);
  assert.equal((await organizer.get("/api/tasks")).data.find((t: any) => t.id === taskForStaff.id).status, "in_progress");
  assert.equal((await organizer.get("/api/tasks")).data.find((t: any) => t.id === taskForMember.id).assigneeMemberId, memberId);
  ok("a member cannot touch someone else's task, reassign, edit or delete");

  // --- 11. expense claims -----------------------------------------------------------
  console.log("Expense claims");
  const admin = await new Client().signIn("admin@e2e.example");
  const claimFields = { title: "Banner rope", amountCents: "25000", spentOn: today, category: "supplies", justification: "Needed to hang the stage banner." };
  const receipt = { field: "evidence", bytes: png, type: "image/png", name: "receipt.png" };
  assert.equal((await anon.form("/api/claims", claimFields, receipt)).status, 401);
  const noPhoto = await member.form("/api/claims", claimFields);
  assert.equal(noPhoto.status, 422);
  assert.ok(noPhoto.error?.fields?.evidence);
  assert.equal((await member.form("/api/claims", claimFields, { ...receipt, bytes: new TextEncoder().encode("not an image") })).status, 422);
  const filed = await member.form("/api/claims", claimFields, receipt);
  assert.equal(filed.status, 200, JSON.stringify(filed.error));
  assert.equal(filed.data.status, "submitted");
  ok("a claim needs a real photo; a volunteer member can file one");

  const expensesBefore = (await treasurer.get("/api/finance/summary")).data;
  const claimRoute = `/api/claims/${filed.data.id}`;
  const receiptRoute = `/api/files/${filed.data.evidenceFileId}`;
  assert.equal((await member.raw(receiptRoute)).status, 200);
  assert.equal((await treasurer.raw(receiptRoute)).status, 200);
  assert.equal((await organizer.raw(receiptRoute)).status, 403);
  assert.equal((await anon.raw(receiptRoute)).status, 401);
  assert.equal((await organizer.get("/api/claims")).data.claims.length, 0);
  assert.equal((await treasurer.get("/api/claims")).data.claims.length, 1);
  ok("the receipt and the claim are visible to the claimant and the reviewers only");

  assert.equal((await member.post(claimRoute, { action: "approve" })).status, 403);
  assert.equal((await organizer.post(claimRoute, { action: "approve" })).status, 403);
  assert.equal((await treasurer.post(claimRoute, { action: "pay", method: "upi" })).status, 409);
  assert.equal((await treasurer.post(claimRoute, { action: "approve" })).data.status, "approved");
  assert.equal((await admin.post(claimRoute, { action: "approve" })).status, 409);
  const afterApproval = (await treasurer.get("/api/finance/summary")).data;
  assert.equal(afterApproval.expensePendingCents, expensesBefore.expensePendingCents + 25000);
  assert.equal(afterApproval.expenseSettledCents, expensesBefore.expenseSettledCents);
  assert.equal((await treasurer.post(claimRoute, { action: "pay", method: "upi" })).data.status, "paid");
  const afterPayment = (await treasurer.get("/api/finance/summary")).data;
  assert.equal(afterPayment.expensePendingCents, expensesBefore.expensePendingCents);
  assert.equal(afterPayment.expenseSettledCents, expensesBefore.expenseSettledCents + 25000);
  assert.equal(afterPayment.transactionCount, expensesBefore.transactionCount + 1);
  assert.equal((await member.get("/api/claims")).data.claims[0].status, "paid");
  ok("only a reviewer can approve; approval adds one unpaid ledger entry and payment settles that same entry");

  const own = await treasurer.form("/api/claims", { ...claimFields, title: "Receipt book" }, receipt);
  assert.equal((await treasurer.post(`/api/claims/${own.data.id}`, { action: "approve" })).status, 403);
  assert.equal((await admin.post(`/api/claims/${own.data.id}`, { action: "reject", reason: "Bought without asking" })).data.status, "rejected");
  ok("a reviewer cannot approve their own claim; another reviewer can reject it with a reason");

  // --- 12. member events, tickets, profile and password -----------------------------
  console.log("Member portal");
  const memberEvent = (await organizer.post("/api/events", { ...eventBody, title: "E2E Member Night", capacity: 1 })).data;
  await organizer.post(`/api/events/${memberEvent.id}/status`, { status: "published" });
  assert.equal((await anon.post(`/api/me/events/${memberEvent.id}/register`, {})).status, 401);
  assert.equal((await organizer.post(`/api/me/events/${memberEvent.id}/register`, {})).status, 403);
  const myTicket = await member.post(`/api/me/events/${memberEvent.id}/register`, { name: "Someone Else", email: "other@e2e.example", priceCents: 0 });
  assert.equal(myTicket.status, 200, JSON.stringify(myTicket.error));
  assert.equal(myTicket.data.paymentStatus, "pending");
  assert.equal(myTicket.data.priceCents, eventBody.memberPriceCents);
  assert.equal((await member.post(`/api/me/events/${memberEvent.id}/register`, {})).status, 409);
  const mineNow = (await member.get("/api/me")).data;
  assert.equal(mineNow.tickets[0].code, myTicket.data.code);
  assert.equal((await new Client().get(`/api/public/tickets/${myTicket.data.code}`)).data.attendeeName, "Mira Member");
  ok("a member registers as themselves at the server's price; the ticket is unpaid until staff record payment");

  assert.equal((await member.post(`/api/me/tickets/${code}/cancel`, {})).status, 404);
  assert.equal((await member.post(`/api/me/tickets/${myTicket.data.code}/cancel`, {})).data.status, "cancelled");
  assert.equal((await member.post(`/api/me/events/${memberEvent.id}/register`, {})).status, 200);
  ok("a member can cancel only their own unpaid ticket, which frees the seat");

  const profile = await member.patch("/api/me", { phone: "98765 43210", studentId: "E2E-1", name: "Root", email: "root@e2e.example", role: "admin" });
  assert.equal(profile.data.phone, "98765 43210");
  assert.equal(profile.data.name, "Mira Member");
  assert.equal(profile.data.email, "mira@e2e.example");
  assert.equal((await member.get("/api/auth/me")).data.user.role, "member");
  assert.ok((await member.get("/api/me/payments")).data.length >= 2);
  assert.equal((await treasurer.get("/api/me/payments")).status, 403);
  assert.equal((await member.get("/api/me/announcements")).status, 200);
  ok("a member edits only their own phone and student ID, and reads only their own payment records");

  const otherDevice = new Client();
  await otherDevice.post("/api/auth/login", { email: memberNo, password: memberPassword });
  assert.equal((await member.post("/api/me/password", { currentPassword: "wrong-password-1", newPassword: "changed-e2e-password" })).status, 422);
  assert.equal((await member.post("/api/me/password", { currentPassword: memberPassword, newPassword: "changed-e2e-password" })).status, 200);
  assert.equal((await member.get("/api/me")).status, 200);
  assert.equal((await otherDevice.get("/api/me")).status, 401);
  assert.equal((await new Client().post("/api/auth/login", { email: memberNo, password: memberPassword })).status, 401);
  ok("changing the password needs the current one and signs other devices out");

  // --- 13. the shop -----------------------------------------------------------------
  console.log("Shop");
  const shopProduct = (
    await treasurer.post("/api/products", { name: "E2E Hoodie", category: "apparel", description: "Warm.", priceCents: 120000, memberPriceCents: 100000, active: true, variants: [{ size: "M", stock: 2 }, { size: "L", stock: 5 }] })
  ).data;
  const sizeM = shopProduct.variants[0].id;
  const sizeL = shopProduct.variants[1].id;
  assert.equal((await organizer.form(`/api/products/${shopProduct.id}/images`, {}, { field: "image", bytes: png, type: "image/png", name: "hoodie.png" })).status, 403);
  const withPhoto = await treasurer.form(`/api/products/${shopProduct.id}/images`, {}, { field: "image", bytes: png, type: "image/png", name: "hoodie.png" });
  assert.equal(withPhoto.status, 200, JSON.stringify(withPhoto.error));
  const photo = await anon.raw(withPhoto.data.images[0].url);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/png");
  // A private receipt is not reachable through the public photo route.
  assert.equal((await anon.raw(`/api/public/product-images/${filed.data.evidenceFileId}`)).status, 404);
  const listed = (await anon.get("/api/public/products")).data.find((p: any) => p.id === shopProduct.id);
  assert.equal(listed.images.length, 1);
  assert.equal((await anon.get(`/api/public/products/${shopProduct.id}`)).data.variants.length, 2);
  ok("staff manage products and photos; the public sees the catalogue, and private uploads stay private");

  const shopper = { name: "Gita Guest", email: "gita@e2e.example" };
  const tampered = await anon.post("/api/public/checkout", { ...shopper, items: [{ variantId: sizeM, quantity: 1, unitPriceCents: 1, totalCents: 1 }], totalCents: 1, paymentStatus: "paid" });
  assert.equal(tampered.status, 200, JSON.stringify(tampered.error));
  assert.equal(tampered.data.totalCents, 120000);
  assert.equal(tampered.data.lines[0].paymentStatus, "pending");
  assert.equal((await anon.post("/api/public/checkout", { ...shopper, items: [{ variantId: sizeM, quantity: 0 }] })).status, 422);
  assert.equal((await anon.post("/api/public/checkout", { ...shopper, items: [] })).status, 422);
  ok("the server prices the order and marks it unpaid whatever the browser sends; bad quantities are refused");

  // Two buyers want two each of a size with one left: at most one unit can go, so both are refused.
  const shortfall = await anon.post("/api/public/checkout", { ...shopper, items: [{ variantId: sizeL, quantity: 1 }, { variantId: sizeM, quantity: 2 }] });
  assert.equal(shortfall.status, 409);
  assert.equal(shortfall.error?.code, "out_of_stock");
  let stock = (await treasurer.get("/api/products")).data.find((p: any) => p.id === shopProduct.id).variants;
  assert.deepEqual(stock.map((v: any) => v.stock), [1, 5]);
  const stockRace = await Promise.all(
    Array.from({ length: 6 }, (_, i) => new Client().post("/api/public/checkout", { name: `Racer ${i}`, email: `racer${i}@e2e.example`, items: [{ variantId: sizeM, quantity: 1 }] })),
  );
  assert.equal(stockRace.filter((r) => r.status === 200).length, 1);
  assert.equal(stockRace.filter((r) => r.status === 409).length, 5);
  stock = (await treasurer.get("/api/products")).data.find((p: any) => p.id === shopProduct.id).variants;
  assert.deepEqual(stock.map((v: any) => v.stock), [0, 5]);
  ok("a cart is all-or-nothing, and six simultaneous buyers of the last unit produce exactly one order");

  const memberOrder = await member.post("/api/me/checkout", { items: [{ variantId: sizeL, quantity: 2 }], name: "Someone Else", email: "other@e2e.example" });
  assert.equal(memberOrder.status, 200, JSON.stringify(memberOrder.error));
  assert.equal(memberOrder.data.totalCents, 200000);
  assert.equal(memberOrder.data.buyerName, "Mira Member");
  assert.equal((await anon.post("/api/me/checkout", { items: [{ variantId: sizeL, quantity: 1 }] })).status, 401);
  assert.equal((await treasurer.post("/api/me/checkout", { items: [{ variantId: sizeL, quantity: 1 }] })).status, 403);
  const history = (await member.get("/api/me/orders")).data;
  assert.deepEqual(history.map((o: any) => o.code), [memberOrder.data.code]);
  assert.equal((await anon.get("/api/me/orders")).status, 401);
  const lineId = memberOrder.data.lines[0].orderId;
  assert.equal((await member.post(`/api/orders/${lineId}`, { action: "pay", method: "upi" })).status, 403);
  assert.equal((await treasurer.post(`/api/orders/${lineId}`, { action: "fulfil" })).status, 409);
  assert.equal((await treasurer.post(`/api/orders/${lineId}`, { action: "pay", method: "upi" })).data.order.paymentStatus, "paid");
  await treasurer.patch(`/api/products/${shopProduct.id}`, { name: "E2E Hoodie v2", category: "apparel", description: "", priceCents: 999900, memberPriceCents: 999900, active: true });
  const afterEdit = (await member.get("/api/me/orders")).data[0];
  assert.equal(afterEdit.lines[0].productName, "E2E Hoodie");
  assert.equal(afterEdit.lines[0].unitPriceCents, 100000);
  assert.equal(afterEdit.unpaidCents, 0);
  ok("a member orders as themselves at the member price, sees only their own history, cannot mark it paid, and old orders keep their price");

  const resetLink = await treasurer.post(`/api/members/${memberId}/setup-link`, {});
  assert.equal(resetLink.status, 200);
  assert.equal((await anon.post("/api/auth/setup", { token: resetLink.data.path.split("/").pop(), password: "a-second-e2e-password" })).status, 200);
  assert.equal((await member.get("/api/me")).status, 401);
  assert.equal((await new Client().post("/api/auth/login", { email: memberNo, password: memberPassword })).status, 401);
  assert.equal((await new Client().post("/api/auth/login", { email: "mira@e2e.example", password: "a-second-e2e-password" })).status, 200);
  ok("a password reset link signs the member out everywhere and replaces the old password");

  // --- paying the membership fee online ---------------------------------------------
  console.log("Online membership payment (Razorpay stand-in, test mode)");
  const onlineRoute = "/api/public/membership/online";
  const membersBefore: number = (await treasurer.get("/api/members")).data.length;
  const duesBefore: number = (await treasurer.get("/api/transactions?category=dues")).data.length;
  const memberCount = async () => (await treasurer.get("/api/members")).data.length as number;
  const confirmBody = (app: any, payment: FakePayment, signature?: string) => ({
    action: "confirm",
    token: app.accessToken,
    razorpayOrderId: app.checkout.orderId,
    razorpayPaymentId: payment.id,
    razorpaySignature: signature ?? signHex(RAZORPAY_KEY_SECRET, `${app.checkout.orderId}|${payment.id}`),
  });

  assert.equal((await anon.get("/api/public/membership")).data.online.available, true);
  const started = await anon.post(onlineRoute, { name: "Omar Online", email: "omar@e2e.example", phone: "9999900001" });
  assert.equal(started.status, 200, JSON.stringify(started.error));
  assert.equal(started.data.status, "pending");
  assert.equal(started.data.checkout.keyId, RAZORPAY_KEY_ID);
  assert.equal(started.data.checkout.amountCents, 50000);
  assert.equal(fakeRazorpay.orders.get(started.data.checkout.orderId)?.amount, 50000);
  assert.ok(!JSON.stringify(started.data).includes(RAZORPAY_KEY_SECRET));
  assert.equal(await memberCount(), membersBefore);
  ok("starting an online application creates a Razorpay order for the fee, and no member");

  const omarPayment = fakeRazorpay.pay(started.data.checkout.orderId);
  const omarRoute = `${onlineRoute}/${started.data.id}`;
  assert.equal((await anon.post(omarRoute, confirmBody(started.data, omarPayment, "0".repeat(64)))).status, 400);
  assert.equal((await anon.post(omarRoute, { ...confirmBody(started.data, omarPayment), token: "x".repeat(43) })).status, 404);
  assert.equal((await anon.post(omarRoute, { action: "resume" })).status, 422);
  assert.equal(await memberCount(), membersBefore);
  ok("a forged signature, a wrong access token or a missing one activates nothing");

  const confirmed = await anon.post(omarRoute, confirmBody(started.data, omarPayment));
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.error));
  assert.equal(confirmed.data.status, "activated");
  assert.match(confirmed.data.setup.path, /^\/activate\//);
  assert.equal(await memberCount(), membersBefore + 1);
  const duesAfter = (await treasurer.get("/api/transactions?category=dues")).data;
  assert.equal(duesAfter.length, duesBefore + 1);
  const omarDues = duesAfter.find((t: any) => t.description.includes(omarPayment.id));
  assert.equal(omarDues.status, "settled");
  assert.equal(omarDues.amountCents, 50000);
  const onlineApplication = (await treasurer.get("/api/applications")).data.find((a: any) => a.code === started.data.code);
  assert.equal(onlineApplication.channel, "razorpay");
  assert.equal(onlineApplication.status, "approved");
  ok("a payment verified with Razorpay creates the member, one settled dues entry and an approved application");

  assert.equal((await anon.post(omarRoute, confirmBody(started.data, omarPayment))).data.setup, null);
  assert.equal(await memberCount(), membersBefore + 1);
  assert.equal((await treasurer.get("/api/transactions?category=dues")).data.length, duesBefore + 1);
  const omarToken: string = confirmed.data.setup.path.split("/").pop();
  assert.equal((await anon.post("/api/auth/setup", { token: omarToken, password: "omar-e2e-password-1" })).status, 200);
  assert.equal((await anon.post("/api/auth/setup", { token: omarToken, password: "omar-e2e-password-2" })).status, 400);
  assert.equal((await new Client().post("/api/auth/login", { email: "omar@e2e.example", password: "omar-e2e-password-1" })).status, 200);
  ok("confirming twice changes nothing, and the password link works once");

  // The browser closes after paying; only the webhook reaches the server.
  const wanda = await anon.post(onlineRoute, { name: "Wanda Webhook", email: "wanda@e2e.example" });
  const wandaPayment = fakeRazorpay.pay(wanda.data.checkout.orderId);
  assert.equal((await deliverWebhook("payment.captured", wandaPayment, "evt_e2e_1", "wrong-secret")).status, 401);
  assert.equal(await memberCount(), membersBefore + 1);
  const delivered = await deliverWebhook("payment.captured", wandaPayment, "evt_e2e_1");
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.data.outcome, "recorded");
  assert.equal((await deliverWebhook("payment.captured", wandaPayment, "evt_e2e_1")).body.data.outcome, "duplicate");
  assert.equal((await deliverWebhook("order.paid", wandaPayment, "evt_e2e_2")).body.data.outcome, "already_recorded");
  assert.equal(await memberCount(), membersBefore + 2);
  assert.equal((await treasurer.get("/api/transactions?category=dues")).data.length, duesBefore + 2);
  ok("a webhook is accepted only with a valid signature over the raw body, and repeats create nothing");

  const wandaBack = await anon.post(`${onlineRoute}/${wanda.data.id}`, { action: "resume", token: wanda.data.accessToken });
  assert.equal(wandaBack.data.status, "activated");
  assert.match(wandaBack.data.setup.path, /^\/activate\//);
  assert.equal((await anon.post("/api/public/applications/status", { code: wanda.data.code, email: "wanda@e2e.example" })).data.status, "approved");
  ok("an applicant who returns after the webhook collects their password link");

  // Paid, but neither the browser nor a webhook told the server. A reviewer checks with Razorpay.
  const rhea = await anon.post(onlineRoute, { name: "Rhea Recovery", email: "rhea@e2e.example" });
  fakeRazorpay.pay(rhea.data.checkout.orderId);
  assert.equal((await anon.get("/api/online-applications")).status, 401);
  assert.equal((await organizer.get("/api/online-applications")).status, 403);
  assert.equal((await organizer.post(`/api/online-applications/${rhea.data.id}`, { action: "check" })).status, 403);
  assert.equal(await memberCount(), membersBefore + 2);
  const checked = await treasurer.post(`/api/online-applications/${rhea.data.id}`, { action: "check" });
  assert.equal(checked.status, 200, JSON.stringify(checked.error));
  assert.equal(checked.data.payment.status, "activated");
  assert.match(checked.data.setup.path, /^\/activate\//);
  assert.equal(await memberCount(), membersBefore + 3);
  assert.equal((await treasurer.get("/api/online-applications")).data.length, 3);
  assert.equal(fakeRazorpay.unauthenticated, 0);
  ok("a reviewer can recover a paid application from Razorpay; other roles cannot see online payments");

  // --- paying for merchandise online --------------------------------------------------
  console.log("Merchandise payment (Razorpay stand-in, test mode)");
  const wandaToken: string = wandaBack.data.setup.path.split("/").pop();
  assert.equal((await anon.post("/api/auth/setup", { token: wandaToken, password: "wanda-e2e-password-1" })).status, 200);
  const wandaShop = new Client();
  assert.equal((await wandaShop.post("/api/auth/login", { email: "wanda@e2e.example", password: "wanda-e2e-password-1" })).status, 200);
  const omarShop = new Client();
  assert.equal((await omarShop.post("/api/auth/login", { email: "omar@e2e.example", password: "omar-e2e-password-1" })).status, 200);

  const forSale = (await anon.get("/api/public/products")).data.find((p: any) => p.variants.some((v: any) => v.stock >= 3));
  const sizeForSale = forSale.variants.find((v: any) => v.stock >= 3);
  const merchOrder = await wandaShop.post("/api/me/checkout", { items: [{ variantId: sizeForSale.id, quantity: 2 }] });
  assert.equal(merchOrder.status, 200, JSON.stringify(merchOrder.error));
  assert.equal(merchOrder.data.payOnline, true);
  assert.ok(merchOrder.data.unpaidCents > 0);
  const owedCents: number = merchOrder.data.unpaidCents;
  const payRoute = `/api/me/orders/${merchOrder.data.code}/pay`;

  assert.equal((await anon.post(payRoute, { action: "start" })).status, 401);
  assert.equal((await treasurer.post(payRoute, { action: "start" })).status, 403);
  assert.equal((await omarShop.post(payRoute, { action: "start" })).status, 404);
  assert.equal((await wandaShop.post("/api/me/orders/CHK-NOSUCH/pay", { action: "start" })).status, 404);
  ok("only the member who owns an order can start paying it; others get 401, 403 or 404");

  const merchOrdersBefore = fakeRazorpay.orders.size;
  const payStart = await wandaShop.post(payRoute, { action: "start", amount: 1, amountCents: 1, totalCents: 1 });
  assert.equal(payStart.status, 200, JSON.stringify(payStart.error));
  assert.equal(payStart.data.checkout.amountCents, owedCents);
  assert.equal(payStart.data.checkout.currency, "INR");
  assert.equal(payStart.data.checkout.keyId, RAZORPAY_KEY_ID);
  assert.equal(fakeRazorpay.orders.get(payStart.data.checkout.orderId)?.amount, owedCents);
  assert.ok(!JSON.stringify(payStart.data).includes(RAZORPAY_KEY_SECRET));
  assert.equal((await wandaShop.post(payRoute, { action: "start" })).data.checkout.orderId, payStart.data.checkout.orderId);
  assert.equal(fakeRazorpay.orders.size, merchOrdersBefore + 1);
  ok("the Razorpay order is for the order's own total in INR, whatever amount the request claims, and a second click reuses it");

  const merchPayment = fakeRazorpay.pay(payStart.data.checkout.orderId);
  const merchConfirm = (signature: string, client = wandaShop) =>
    client.post(payRoute, {
      action: "confirm",
      razorpayOrderId: payStart.data.checkout.orderId,
      razorpayPaymentId: merchPayment.id,
      razorpaySignature: signature,
    });
  const goodSignature = signHex(RAZORPAY_KEY_SECRET, `${payStart.data.checkout.orderId}|${merchPayment.id}`);
  assert.equal((await merchConfirm("0".repeat(64))).status, 400);
  assert.equal((await merchConfirm(goodSignature, omarShop)).status, 404);
  assert.equal((await wandaShop.get("/api/me/orders")).data[0].unpaidCents, owedCents);
  ok("a forged signature, or another member presenting a real one, marks nothing paid");

  const merchPaid = await merchConfirm(goodSignature);
  assert.equal(merchPaid.status, 200, JSON.stringify(merchPaid.error));
  assert.equal(merchPaid.data.order.unpaidCents, 0);
  assert.equal(merchPaid.data.checkout, null);
  const wandaOrders = (await wandaShop.get("/api/me/orders")).data;
  assert.equal(wandaOrders[0].unpaidCents, 0);
  assert.equal(wandaOrders[0].payOnline, false);
  assert.deepEqual(wandaOrders[0].lines.map((l: any) => [l.paymentStatus, l.status]), [["paid", "placed"]]);
  const merchEntries = (await treasurer.get("/api/transactions?category=merchandise")).data.filter((t: any) => t.description.includes(merchPayment.id));
  assert.equal(merchEntries.length, 1);
  assert.equal(merchEntries[0].status, "settled");
  assert.equal(merchEntries[0].amountCents, owedCents);
  ok("a payment verified with Razorpay marks the order paid and settles its ledger entry");

  assert.equal((await merchConfirm(goodSignature)).data.order.unpaidCents, 0);
  assert.equal((await deliverWebhook("payment.captured", merchPayment, "evt_e2e_merch_1")).body.data.outcome, "already_recorded");
  assert.equal((await wandaShop.post(payRoute, { action: "start" })).status, 409);
  assert.equal((await treasurer.get("/api/transactions?category=merchandise")).data.filter((t: any) => t.description.includes(merchPayment.id)).length, 1);
  assert.equal(fakeRazorpay.orders.size, merchOrdersBefore + 1);
  ok("confirming again, a webhook for the same payment, and a second attempt to pay all change nothing");

  const paidLine = (await treasurer.get("/api/orders")).data.find((o: any) => o.checkoutCode === merchOrder.data.code);
  assert.equal(paidLine.paymentStatus, "paid");
  assert.equal(paidLine.status, "placed");
  assert.equal((await treasurer.post(`/api/orders/${paidLine.id}`, { action: "fulfil" })).status, 200);
  assert.equal((await wandaShop.get("/api/me/orders")).data[0].lines[0].status, "fulfilled");
  ok("hand-over stays a separate committee step after an online payment");

  // The browser closes after paying: only the webhook tells the server.
  const secondOrder = await wandaShop.post("/api/me/checkout", { items: [{ variantId: sizeForSale.id, quantity: 1 }] });
  const secondRoute = `/api/me/orders/${secondOrder.data.code}/pay`;
  const laterStart = await wandaShop.post(secondRoute, { action: "start" });
  const secondPayment = fakeRazorpay.pay(laterStart.data.checkout.orderId);
  assert.equal((await deliverWebhook("payment.captured", secondPayment, "evt_e2e_merch_2", "wrong-secret")).status, 401);
  assert.equal((await wandaShop.get("/api/me/orders")).data[0].unpaidCents, secondOrder.data.unpaidCents);
  assert.equal((await deliverWebhook("payment.captured", secondPayment, "evt_e2e_merch_2")).body.data.outcome, "order_paid");
  assert.equal((await deliverWebhook("payment.captured", secondPayment, "evt_e2e_merch_2")).body.data.outcome, "duplicate");
  assert.equal((await wandaShop.get("/api/me/orders")).data[0].unpaidCents, 0);
  assert.equal(await memberCount(), membersBefore + 3);
  assert.equal((await anon.get("/api/order-payments")).status, 401);
  assert.equal((await organizer.get("/api/order-payments")).status, 403);
  assert.equal((await treasurer.get("/api/order-payments")).data.length, 2);
  ok("a signed webhook pays a merchandise order once, creates no member, and payment records stay with the treasurer and president");

  // --- volunteering: members ask, organizers approve ------------------------------------
  console.log("Volunteering");
  const helpTask = await organizer.post("/api/tasks", { title: "Staff the welcome desk", eventId, volunteerSlots: 1 });
  assert.equal(helpTask.status, 200, JSON.stringify(helpTask.error));
  assert.equal(helpTask.data.volunteerSlots, 1);
  assert.equal((await anon.get("/api/me/volunteering")).status, 401);
  assert.equal((await treasurer.get("/api/me/volunteering")).status, 403);
  const openings = (await wandaShop.get("/api/me/volunteering")).data;
  const opening = openings.opportunities.find((o: any) => o.taskId === helpTask.data.id);
  assert.deepEqual([opening.needed, opening.approved, opening.pending, opening.remaining, opening.myRequest], [1, 0, 0, 1, null]);
  ok("a member sees tasks opened to volunteers, with counts; visitors and committee accounts do not use the member list");

  const wandaAsk = await wandaShop.post("/api/me/volunteering", { taskId: helpTask.data.id, memberId: "mem_someone_else", status: "approved" });
  assert.equal(wandaAsk.status, 200, JSON.stringify(wandaAsk.error));
  assert.equal(wandaAsk.data.status, "pending");
  assert.equal((await wandaShop.post("/api/me/volunteering", { taskId: helpTask.data.id })).status, 409);
  assert.equal((await wandaShop.get("/api/me/tasks")).data.length, 0);
  const omarAsk = await omarShop.post("/api/me/volunteering", { taskId: helpTask.data.id });
  assert.equal(omarAsk.data.status, "pending");
  ok("asking creates a pending request, assigns nothing, and cannot be repeated or forced to approved");

  const reviewPath = (id: string) => `/api/volunteer-requests/${id}`;
  assert.equal((await wandaShop.post(reviewPath(wandaAsk.data.id), { action: "approve" })).status, 403);
  assert.equal((await treasurer.post(reviewPath(wandaAsk.data.id), { action: "approve" })).status, 403);
  assert.equal((await treasurer.get("/api/volunteer-requests")).status, 403);
  assert.equal((await anon.post(reviewPath(wandaAsk.data.id), { action: "approve" })).status, 401);
  assert.equal((await omarShop.post(`/api/me/volunteering/${wandaAsk.data.id}`, { action: "withdraw" })).status, 404);
  assert.equal((await organizer.get("/api/volunteer-requests")).data.filter((r: any) => r.status === "pending").length, 2);
  ok("only the president and organizers can see or decide requests; a member cannot approve their own or touch another's");

  // Both approvals at once for the single position: exactly one wins.
  const raced = await Promise.all([organizer.post(reviewPath(wandaAsk.data.id), { action: "approve" }), organizer.post(reviewPath(omarAsk.data.id), { action: "approve" })]);
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409]);
  const winner = raced[0].status === 200 ? wandaShop : omarShop;
  const loser = raced[0].status === 200 ? omarShop : wandaShop;
  const loserRequest = raced[0].status === 200 ? omarAsk : wandaAsk;
  assert.equal(raced.find((r) => r.status === 409)!.error?.code, "task_full");
  assert.deepEqual((await winner.get("/api/me/tasks")).data.map((t: any) => t.id), [helpTask.data.id]);
  assert.equal((await loser.get("/api/me/tasks")).data.length, 0);
  const staffedTask = (await organizer.get("/api/tasks")).data.find((t: any) => t.id === helpTask.data.id);
  assert.deepEqual([staffedTask.approvedVolunteers, staffedTask.pendingVolunteers, staffedTask.status], [1, 1, "todo"]);
  ok("two approvals at once cannot overfill a task; the approved member gets the task, still in To do");

  const rejected = await organizer.post(reviewPath(loserRequest.data.id), { action: "reject", reason: "The desk is covered." });
  assert.equal(rejected.data.status, "rejected");
  assert.equal((await loser.get("/api/me/volunteering")).data.requests.find((r: any) => r.id === loserRequest.data.id).reviewNote, "The desk is covered.");
  assert.equal((await winner.call("PATCH", `/api/me/tasks/${helpTask.data.id}`, { action: "start" })).data.status, "in_progress");
  assert.equal((await loser.call("PATCH", `/api/me/tasks/${helpTask.data.id}`, { action: "done" })).status, 404);
  ok("a rejected member sees the reason and gets no task; the approved volunteer can progress it");

  // --- a session lasts across public and member pages --------------------------------
  console.log("Session persistence");
  const loginReply = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "omar@e2e.example", password: "omar-e2e-password-1" }),
  });
  assert.equal(loginReply.status, 200);
  const sessionCookie = loginReply.headers.get("set-cookie") ?? "";
  assert.match(sessionCookie, /^skyline_session=[^;]+;/);
  assert.match(sessionCookie, /;\s*Path=\/(;|$)/i);
  assert.match(sessionCookie, /;\s*HttpOnly/i);
  assert.match(sessionCookie, /;\s*SameSite=lax/i);
  assert.match(sessionCookie, /;\s*Expires=/i);
  // Plain HTTP on this machine: a Secure cookie would never be sent back.
  assert.doesNotMatch(sessionCookie, /;\s*Secure/i);
  ok("the session cookie is HttpOnly, SameSite=Lax, has an expiry and covers every path");

  const cookiePair = sessionCookie.split(";")[0];
  const omar = new Client({ Cookie: cookiePair });
  const whoAmI = async () => (await omar.get("/api/auth/me")).data.user;
  assert.equal((await whoAmI()).role, "member");
  // Dashboard, then the public shop, events and join pages and their APIs, then back.
  for (const pagePath of ["/member", "/shop", "/shop/cart", "/events", "/join", "/", "/member/membership"]) {
    const visited = await omar.raw(pagePath);
    assert.equal(visited.status, 200, `${pagePath} should load for a signed-in member`);
    assert.equal(visited.headers.get("set-cookie"), null, `${pagePath} must not touch the session cookie`);
    await visited.text();
  }
  for (const publicApi of ["/api/public/products", "/api/public/events", "/api/public/membership", "/api/public/announcements"]) {
    const reply = await fetch(BASE + publicApi, { headers: { Cookie: cookiePair } });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("set-cookie"), null, `${publicApi} must not touch the session cookie`);
  }
  assert.equal((await whoAmI()).email, "omar@e2e.example");
  const omarRecord = await omar.get("/api/me");
  assert.equal(omarRecord.status, 200);
  assert.equal((await whoAmI()).memberNo, omarRecord.data.memberNo);
  ok("a member stays signed in across the dashboard, Merchandise, Events and Become a member, and on reload");

  const membersNow = await memberCount();
  const ordersAtRazorpay = fakeRazorpay.orders.size;
  const secondStart = await omar.post(onlineRoute, { name: "Omar Again", email: "omar.second@e2e.example" });
  assert.equal(secondStart.status, 409);
  assert.equal(secondStart.error?.code, "already_member");
  const manualAgain = await omar.form("/api/public/applications", { name: "Omar Again", email: "omar.third@e2e.example", paymentMethod: "cash", paymentReference: "Paid Tariq" });
  assert.equal(manualAgain.status, 409);
  const omarResume = await anon.post(omarRoute, { action: "resume", token: started.data.accessToken });
  assert.equal(omarResume.data.status, "activated");
  assert.equal(omarResume.data.passwordSet, true);
  assert.equal(omarResume.data.setup, null);
  assert.equal(omarResume.data.canRequestLink, false);
  assert.equal(await memberCount(), membersNow);
  assert.equal(fakeRazorpay.orders.size, ordersAtRazorpay);
  ok("a signed-in member cannot start another application, and revisiting a finished one creates nothing and offers no link");

  const visitor = new Client();
  for (const pagePath of ["/shop", "/join", "/events"]) assert.equal((await visitor.raw(pagePath)).status, 200);
  assert.equal((await visitor.get("/api/public/products")).status, 200);
  assert.equal((await visitor.get("/api/auth/me")).data.user, null);
  for (const memberApi of ["/api/me", "/api/me/orders", "/api/me/tasks", "/api/me/payments"]) {
    assert.equal((await visitor.get(memberApi)).status, 401);
  }
  assert.equal((await visitor.raw("/member")).status, 307);
  ok("a visitor can still browse Merchandise and the membership page; member pages and APIs refuse them");

  assert.equal((await omar.post("/api/auth/logout")).status, 200);
  assert.equal(await whoAmI(), null);
  assert.equal((await omar.get("/api/me")).status, 401);
  ok("only signing out ends the session, and the old cookie then stops working");

  // --- the committee authorization policy, over HTTP -------------------------------
  console.log("Roles");
  const memberAndMoney = ["/api/members", `/api/members/${memberId}`, "/api/transactions", `/api/transactions?eventId=${eventId}`, "/api/finance/summary", "/api/orders", "/api/order-payments", "/api/online-applications", "/api/applications"];
  for (const route of memberAndMoney) {
    assert.equal((await organizer.get(route)).status, 403, `${route} should refuse an organizer`);
    assert.equal((await treasurer.get(route)).status, 200, `${route} should allow the treasurer`);
    assert.equal((await admin.get(route)).status, 200, `${route} should allow the president`);
  }
  ok("member records, the ledger, summaries, orders and payment records: president and treasurer 200, organizer 403");

  const organizerEvent = await organizer.get(`/api/events/${eventId}`);
  assert.equal(organizerEvent.status, 200);
  assert.equal(organizerEvent.data.event.finance, null);
  assert.equal(organizerEvent.data.breakEven, null);
  assert.equal(organizerEvent.data.profitTarget, null);
  assert.ok(organizerEvent.data.tickets.length > 0);
  assert.ok((await organizer.get("/api/events")).data.every((e: any) => e.finance === null));
  assert.ok((await treasurer.get(`/api/events/${eventId}`)).data.event.finance.incomeSettledCents > 0);
  const organizerHome = (await organizer.get("/api/dashboard")).data;
  assert.equal(organizerHome.finance, null);
  assert.equal(organizerHome.members, null);
  assert.deepEqual(organizerHome.cashflow, []);
  assert.ok(organizerHome.eventPerformance.every((e: any) => e.netCents === null && e.incomeSettledCents === null));
  assert.ok(organizerHome.alerts.every((a: any) => a.kind === "overdue_tasks"));
  assert.ok((await treasurer.get("/api/dashboard")).data.finance.incomeSettledCents > 0);
  assert.ok(!/incomeSettledCents":\d|netCents":-?\d/.test(JSON.stringify([organizerEvent.data, organizerHome])));
  ok("an organizer still gets events, registrations and a dashboard, with every ledger figure and member count removed");

  const roleEvent = (await organizer.post("/api/events", { ...eventBody, title: "E2E Role Night", capacity: 10 })).data;
  assert.equal(roleEvent.finance, null);
  const published = await organizer.post(`/api/events/${roleEvent.id}/status`, { status: "published" });
  assert.equal(published.data.event.finance, null);
  assert.equal((await organizer.patch(`/api/events/${roleEvent.id}`, { ...eventBody, title: "E2E Role Night", capacity: 12 })).data.finance, null);
  ok("creating, editing and publishing an event answer an organizer without ledger figures too");

  const paidSeat = (await treasurer.post(`/api/events/${roleEvent.id}/registrations`, { name: "Paula Paid", email: "paula.paid@campus.example", payNow: "cash" })).data;
  const unpaidSeat = (await organizer.post(`/api/events/${roleEvent.id}/registrations`, { name: "Uma Unpaid", email: "uma.unpaid@campus.example" })).data;
  assert.equal(paidSeat.paymentStatus, "paid");
  assert.equal(unpaidSeat.paymentStatus, "pending");
  assert.equal((await organizer.post(`/api/tickets/${paidSeat.code}`, { action: "cancel" })).status, 403);
  assert.equal((await treasurer.post(`/api/tickets/${unpaidSeat.code}`, { action: "cancel" })).status, 403);
  assert.equal((await organizer.post(`/api/tickets/${unpaidSeat.code}`, { action: "cancel" })).data.refundDueCents, 0);
  assert.equal((await treasurer.post(`/api/tickets/${paidSeat.code}`, { action: "cancel" })).status, 403);
  assert.equal((await admin.post(`/api/tickets/${paidSeat.code}`, { action: "cancel" })).data.refundDueCents, paidSeat.priceCents);
  ok("only the president cancels a paid ticket (which records a refund); an organizer cancels unpaid ones; the treasurer neither");
  const refundEntry = (await treasurer.get(`/api/transactions?eventId=${roleEvent.id}`)).data.find((t: any) => t.source === "refund");
  assert.equal(refundEntry.status, "pending");
  assert.equal((await treasurer.post(`/api/transactions/${refundEntry.id}`, { action: "settle" })).status, 403);
  assert.equal((await treasurer.post(`/api/transactions/${refundEntry.id}`, { action: "void", reason: "Not refunding" })).status, 403);
  assert.equal((await organizer.post(`/api/transactions/${refundEntry.id}`, { action: "settle" })).status, 403);
  assert.equal((await admin.post(`/api/transactions/${refundEntry.id}`, { action: "settle", method: "bank" })).data.status, "settled");
  ok("only the president pays out or voids a refund; the treasurer sees it and gets 403");

  const roleProduct = (
    await treasurer.post("/api/products", { name: "E2E Role Mug", category: "other", description: "", priceCents: 30000, memberPriceCents: 25000, active: true, variants: [{ size: "One", stock: 2 }] })
  ).data;
  const roleOrder = await wandaShop.post("/api/me/checkout", { items: [{ variantId: roleProduct.variants[0].id, quantity: 1 }] });
  assert.equal(roleOrder.status, 200, JSON.stringify(roleOrder.error));
  const roleLine = roleOrder.data.lines[0].orderId;
  assert.equal((await treasurer.post(`/api/orders/${roleLine}`, { action: "pay", method: "cash" })).data.order.paymentStatus, "paid");
  assert.equal((await treasurer.post(`/api/orders/${roleLine}`, { action: "cancel" })).status, 403);
  assert.equal((await organizer.post(`/api/orders/${roleLine}`, { action: "cancel" })).status, 403);
  assert.equal((await treasurer.get("/api/orders")).data.find((o: any) => o.id === roleLine).status, "placed");
  const cancelledOrder = await admin.post(`/api/orders/${roleLine}`, { action: "cancel" });
  assert.equal(cancelledOrder.data.order.status, "cancelled");
  assert.ok(cancelledOrder.data.refundDueCents > 0);
  for (const client of [treasurer, organizer]) {
    assert.equal((await client.post("/api/order-payments/opy_missing", { action: "refunded", note: "Refunded in the dashboard" })).status, 403);
  }
  assert.equal((await admin.post("/api/order-payments/opy_missing", { action: "refunded", note: "Refunded in the dashboard" })).status, 404);
  ok("only the president cancels a paid merchandise order or marks an online order payment refunded; the treasurer and organizer get 403");

  await treasurer.post(`/api/events/${roleEvent.id}/registrations`, { name: "Rita Refund", email: "rita.refund@campus.example", payNow: "cash" });
  for (const client of [organizer, treasurer]) {
    assert.equal((await client.post(`/api/events/${roleEvent.id}/status`, { status: "cancelled" })).status, 403);
  }
  assert.equal((await organizer.get(`/api/events/${roleEvent.id}`)).data.event.status, "published");
  assert.equal((await treasurer.post("/api/events", { ...eventBody, title: "Treasurer's event" })).status, 403);
  assert.equal((await treasurer.patch(`/api/events/${roleEvent.id}`, { ...eventBody, title: "Renamed" })).status, 403);
  assert.equal((await treasurer.post(`/api/events/${roleEvent.id}/status`, { status: "draft" })).status, 403);
  const cancelledEvent = await admin.post(`/api/events/${roleEvent.id}/status`, { status: "cancelled" });
  assert.equal(cancelledEvent.data.event.status, "cancelled");
  assert.ok(cancelledEvent.data.refundsDueCents > 0);
  ok("only the president cancels a whole event; the organizer manages it otherwise; the treasurer cannot create, edit, publish or cancel");

  for (const client of [treasurer, organizer]) {
    assert.equal((await client.get("/api/accounts")).status, 403);
  }
  const accounts = (await admin.get("/api/accounts")).data;
  assert.equal(accounts.length, 4);
  assert.ok(!/password|hash/i.test(JSON.stringify(accounts)));
  const leaverId = accounts.find((a: any) => a.email === "leaver@e2e.example").id;
  const selfId = accounts.find((a: any) => a.isYou).id;
  const leaver = await new Client().signIn("leaver@e2e.example");
  assert.equal((await leaver.get("/api/events")).status, 200);
  assert.equal((await treasurer.post(`/api/accounts/${leaverId}`, { action: "disable" })).status, 403);
  assert.equal((await organizer.post(`/api/accounts/${leaverId}`, { action: "disable" })).status, 403);
  assert.equal((await admin.post(`/api/accounts/${selfId}`, { action: "disable" })).error?.code, "own_account");
  assert.equal((await admin.post(`/api/accounts/${leaverId}`, { action: "delete" })).status, 422);
  ok("only the president can list or change committee accounts, and not their own");

  const leaverTask = (await leaver.post("/api/tasks", { title: "Leaver's last task" })).data;
  assert.equal((await admin.post(`/api/accounts/${leaverId}`, { action: "disable" })).data.disabledAt !== null, true);
  assert.equal((await leaver.get("/api/events")).status, 401);
  assert.equal((await leaver.get("/api/auth/me")).data.user, null);
  assert.equal((await anon.post("/api/auth/login", { email: "leaver@e2e.example", password: PASSWORD })).error?.code, "invalid_credentials");
  assert.ok((await organizer.get("/api/tasks")).data.some((t: any) => t.id === leaverTask.id));
  ok("disabling an account ends its live session at once and stops sign-in; what it recorded stays");
  assert.equal((await admin.post(`/api/accounts/${leaverId}`, { action: "enable" })).data.disabledAt, null);
  assert.equal((await (await new Client().signIn("leaver@e2e.example")).get("/api/events")).status, 200);
  assert.equal((await admin.post(`/api/accounts/${leaverId}`, { action: "disable" })).status, 200);
  ok("enabling restores sign-in with the same password");

  // Committee management from the web: add, promote a member, change a role.
  const newPerson = { role: "organizer", name: "Nadia New", email: "nadia.new@e2e.example" };
  for (const client of [treasurer, organizer, member, anon]) {
    const refused = await client.post("/api/accounts", { ...newPerson, role: "admin" });
    // Signed-in committee roles are refused outright; a member or a visitor never gets as far as the role check.
    if (client === treasurer || client === organizer) assert.equal(refused.status, 403);
    else assert.ok([401, 403].includes(refused.status));
    assert.ok([401, 403].includes((await client.patch(`/api/accounts/${leaverId}`, { role: "admin" })).status));
    assert.ok([401, 403].includes((await client.post(`/api/accounts/${leaverId}/setup-link`, {})).status));
  }
  assert.equal((await admin.post("/api/accounts", { ...newPerson, password: "chosen-by-the-caller" })).status, 422);
  assert.equal((await admin.post("/api/accounts", { ...newPerson, role: "member" })).status, 422);
  assert.equal((await admin.post("/api/accounts", { ...newPerson, email: "TREASURER@e2e.example" })).error?.code, "email_taken");
  const invited = await admin.post("/api/accounts", newPerson);
  assert.equal(invited.status, 200, JSON.stringify(invited.error));
  assert.equal(invited.data.account.setupPending, true);
  assert.ok(!/password|hash/i.test(JSON.stringify(invited.data)));
  const inviteToken = invited.data.setupLink.path.split("/").pop();
  assert.equal((await anon.get(invited.data.setupLink.path)).status, 200);
  assert.equal((await anon.post("/api/auth/login", { email: newPerson.email, password: "unset" })).status, 401);
  assert.equal((await anon.post("/api/auth/staff-setup/check", { token: inviteToken })).data.role, "organizer");
  assert.equal((await anon.post("/api/auth/staff-setup", { token: inviteToken, password: "short" })).status, 422);
  assert.equal((await anon.post("/api/auth/staff-setup", { token: inviteToken, password: "nadia chooses her own" })).data.email, newPerson.email);
  assert.equal((await anon.post("/api/auth/staff-setup", { token: inviteToken, password: "someone tries again" })).error?.code, "invalid_link");
  const nadia = new Client();
  assert.equal((await nadia.post("/api/auth/login", { email: newPerson.email, password: "nadia chooses her own" })).data.user.role, "organizer");
  assert.equal((await nadia.get("/api/finance/summary")).status, 403);
  ok("the president adds a committee account; the person sets their own password with a one-time link; nobody else can add one");

  const changed = await admin.patch(`/api/accounts/${invited.data.account.id}`, { role: "treasurer" });
  assert.equal(changed.data.role, "treasurer");
  assert.equal((await nadia.get("/api/events")).status, 401);
  await nadia.post("/api/auth/login", { email: newPerson.email, password: "nadia chooses her own" });
  assert.equal((await nadia.get("/api/finance/summary")).status, 200);
  assert.equal((await nadia.get("/api/accounts")).status, 403);
  assert.equal((await nadia.patch(`/api/accounts/${invited.data.account.id}`, { role: "admin" })).status, 403);
  assert.equal((await admin.patch(`/api/accounts/${selfId}`, { role: "treasurer" })).error?.code, "own_account");
  assert.equal((await admin.patch(`/api/accounts/${invited.data.account.id}`, { role: "treasurer" })).error?.code, "same_role");
  assert.equal((await admin.patch(`/api/accounts/${invited.data.account.id}`, { role: "owner" })).status, 422);
  ok("changing a role signs the account out and the new role applies at once; a president cannot change their own");
  assert.equal((await admin.post(`/api/accounts/${invited.data.account.id}/setup-link`, {})).data.role, "treasurer");
  await admin.patch(`/api/accounts/${invited.data.account.id}`, { role: "admin" });
  assert.equal((await admin.post(`/api/accounts/${invited.data.account.id}/setup-link`, {})).status, 403);
  await admin.patch(`/api/accounts/${invited.data.account.id}`, { role: "treasurer" });
  ok("a president can create a password link for a treasurer but not for another president");

  const memberBefore = (await admin.get(`/api/members/${memberId}`)).data;
  const membersBefore2 = (await admin.get("/api/members")).data.length;
  const promoted = await admin.post("/api/accounts", { role: "organizer", memberId });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.error));
  assert.equal(promoted.data.account.memberNo, memberBefore.memberNo);
  assert.equal(promoted.data.account.email, memberBefore.email);
  assert.equal((await admin.post("/api/accounts", { role: "treasurer", memberId })).error?.code, "already_committee");
  assert.deepEqual((await admin.get(`/api/members/${memberId}`)).data, memberBefore);
  assert.equal((await admin.get("/api/members")).data.length, membersBefore2);
  assert.equal((await admin.get("/api/accounts")).data.length, 6);
  ok("promoting a member adds a linked committee account and leaves the member record as it was");

  // --- cross-site requests ---------------------------------------------------------
  const crossSite = new Client({ Origin: "https://evil.example" });
  await crossSite.signIn("organizer@e2e.example").then(
    () => assert.fail("a cross-site login should have been refused"),
    () => undefined,
  );
  ok("a cross-site POST is refused");

  // --- persistence ---------------------------------------------------------------
  console.log("Persistence");
  await stopServer();
  await startServer(dbPath);
  const afterRestart = await new Client().signIn("treasurer@e2e.example");
  const survived = (await afterRestart.get(`/api/events/${eventId}`)).data;
  assert.equal(survived.event.stats.registered, 5);
  assert.equal(survived.event.stats.checkedIn, 2);
  assert.equal(survived.event.finance.netCents, 150000);
  assert.equal((await new Client().get(`/api/public/tickets/${code}`)).data.checkedInAt, admitted.data.ticket.checkedInAt);
  ok("after a server restart the event, tickets, check-ins and money are all still there");
  assert.equal((await organizer.get("/api/dashboard")).status, 200);
  ok("sessions survive a restart (stored in the database)");

  await stopServer();
  fakeRazorpay.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nAll ${passed} checks passed.`);
}

main().catch(async (error) => {
  await stopServer();
  fakeRazorpay.stop();
  console.error("\nEnd-to-end check FAILED\n");
  console.error(error);
  process.exit(1);
});
