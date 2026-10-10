/**
 * End-to-end check over HTTP against the production build.
 *
 *   npm run build && npm run e2e
 *
 * Starts `next start` on a temporary database, drives the real API the way
 * the UI does, restarts the server to prove the data persisted, and exits
 * non-zero on the first failed assertion. Nothing here touches data/skyline.db.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- responses are untyped JSON here on purpose; each field used is asserted */
import assert from "node:assert/strict";
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
    env: { ...process.env, NODE_ENV: "production", SKYLINE_DB_PATH: dbPath, SKYLINE_DISABLE_RATE_LIMIT: "1" },
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

  // Accounts are created directly, as an administrator would with the seed script.
  process.env.SKYLINE_DB_PATH = dbPath;
  createUser({ email: "admin@e2e.example", name: "Asha Admin", role: "admin", password: PASSWORD });
  createUser({ email: "treasurer@e2e.example", name: "Tariq Treasurer", role: "treasurer", password: PASSWORD });
  createUser({ email: "organizer@e2e.example", name: "Omar Organizer", role: "organizer", password: PASSWORD });
  closeDb();

  console.log(`Skyline end-to-end check\n  database: ${dbPath}\n  server:   ${BASE}\n`);
  await startServer(dbPath);

  const anon = new Client();
  const organizer = await new Client().signIn("organizer@e2e.example");
  const treasurer = await new Client().signIn("treasurer@e2e.example");

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
  const admitted = await organizer.post("/api/tickets/check-in", { code: code.toLowerCase().replace(/-/g, " "), eventId, collectPayment: true, method: "upi" });
  assert.equal(admitted.data.outcome, "checked_in");
  assert.equal(admitted.data.ticket.paymentStatus, "paid");
  ok("collecting payment at the door admits the holder (code typed loosely)");
  const again = await organizer.post("/api/tickets/check-in", { code, eventId, collectPayment: true });
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
  const claim = await organizer.post("/api/transactions", { ...entry, type: "expense", category: "reimbursement", amountCents: 30000, status: "pending", description: "Decorations", counterparty: "Omar Organizer" });
  assert.equal(claim.status, 200);
  assert.equal((await organizer.post(`/api/transactions/${claim.data.id}`, { action: "settle" })).status, 403);
  ok("treasurer records income and an expense; organizer files a claim but cannot settle it");

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

  // --- 8. assistant ---------------------------------------------------------------
  console.log("Assistant");
  assert.equal((await anon.post("/api/assistant", { question: "What is our financial position?" })).status, 401);
  const most = (await treasurer.post("/api/assistant", { question: "Which event has the most registrations?" })).data;
  assert.equal(most.engine, "rules");
  assert.ok(most.answer.includes("E2E Spring Gala has the most registrations: 5 of 5 seats (100% full)"), most.answer);
  const position = (await treasurer.post("/api/assistant", { question: "What is the current financial position?" })).data;
  assert.ok(position.answer.includes("collected ₹3,000") && position.answer.includes("net position is ₹1,500"), position.answer);
  assert.ok(position.facts.some((x: any) => x.kind === "estimate") && position.facts.some((x: any) => x.kind === "actual"));
  const breakEven = (await treasurer.post("/api/assistant", { question: "How many tickets must the Spring Gala sell to break even?" })).data;
  // Costs 1,800 are fully covered by the 2,000 sponsorship.
  assert.ok(breakEven.answer.includes("already breaks even without ticket sales"), breakEven.answer);
  assert.deepEqual(detail.breakEven.toCoverCents, 0);
  const target = (await treasurer.post("/api/assistant", { question: "How much more revenue does the Spring Gala need to reach its profit target?" })).data;
  assert.ok(target.answer.includes("already reached its profit target of ₹1,000"), target.answer);
  ok("answers match the stored data and label actuals and estimates; engine reported as rule-based");

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
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nAll ${passed} checks passed.`);
}

main().catch(async (error) => {
  await stopServer();
  console.error("\nEnd-to-end check FAILED\n");
  console.error(error);
  process.exit(1);
});
