import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memberInputSchema, productInputSchema, transactionInputSchema } from "@/lib/contracts";
import { ADMIN_PASSWORD_MIN, createCommitteeAccount, createFirstAdmin, resetAdminPassword } from "@/server/admin-setup";
import { createUser, getSessionUser, login, logout } from "@/server/auth";
import { all, closeDb, dbKind, get, run, today, tx, wipeAllData } from "@/server/db";
import { isServerless, resolveDbConfig } from "@/server/db/config";
import { migratePostgres, openPostgres, toPostgresSql } from "@/server/db/postgres";
import {
  CRITICAL_UNIQUE_COLUMNS,
  CRITICAL_UNIQUE_INDEXES,
  EXPECTED_TABLES,
  MIGRATIONS_TABLE,
  POSTGRES_MIGRATIONS,
  POSTGRES_SCHEMA_VERSION,
} from "@/server/db/postgres-schema";
import { openSqlite } from "@/server/db/sqlite";
import { DatabaseUnavailableError, isDatabaseUnavailable } from "@/server/db/types";
import { AppError } from "@/server/errors";
import { failure } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";
import { createAnnouncement } from "@/server/services/announcements";
import { listApplications } from "@/server/services/applications";
import { createEvent, setEventStatus } from "@/server/services/events";
import { createTransaction } from "@/server/services/finance";
import { createMember, listMembers } from "@/server/services/members";
import { createProduct, setStockLevels } from "@/server/services/merch";
import { checkIn, registerForEvent, undoCheckIn } from "@/server/services/tickets";
import { openFile, storeImage, storedFileIds } from "@/server/storage";
import { appError, eventInput, freshDb, onPostgres, person, publishedEvent, type Staff } from "./helpers";

/**
 * The database layer itself. Everything outside the "PostgreSQL only" block
 * runs on both databases (`npm test` on SQLite, `npm run test:pg` on a real,
 * disposable PostgreSQL server).
 */

let staff: Staff;
beforeEach(async () => {
  staff = await freshDb();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const member = (n: number, overrides: Record<string, unknown> = {}) =>
  memberInputSchema.parse({ name: `Member ${n}`, email: `member${n}@campus.example`, duesPaid: true, ...overrides });

/** Runs `fn` with environment variables changed, then puts them back. */
async function withEnv<T>(changes: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(changes);
  try {
    return await fn();
  } finally {
    apply(before);
  }
}
const NOT_HOSTED = { AWS_LAMBDA_FUNCTION_NAME: undefined, LAMBDA_TASK_ROOT: undefined, NETLIFY: undefined };

describe("which database is used", () => {
  const reason = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) return error.reason;
      throw error;
    }
    throw new Error("expected DatabaseUnavailableError");
  };

  it("needs DATABASE_URL in production and never falls back to a local file", async () => {
    await withEnv({ ...NOT_HOSTED, NODE_ENV: "production", DATABASE_URL: undefined, SKYLINE_DB_DRIVER: undefined }, () => {
      expect(reason(resolveDbConfig)).toBe("DATABASE_URL is not set");
    });
    await withEnv({ ...NOT_HOSTED, NODE_ENV: "production", DATABASE_URL: undefined, SKYLINE_DB_DRIVER: "postgres" }, () => {
      expect(reason(resolveDbConfig)).toBe("DATABASE_URL is not set");
    });
  });

  it("uses PostgreSQL whenever DATABASE_URL is set", async () => {
    await withEnv({ ...NOT_HOSTED, NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db.example/skyline", SKYLINE_DB_DRIVER: undefined }, () => {
      expect(resolveDbConfig().kind).toBe("postgres");
    });
    await withEnv({ ...NOT_HOSTED, NODE_ENV: "development", DATABASE_URL: "postgres://u:p@db.example/skyline", SKYLINE_DB_DRIVER: undefined }, () => {
      expect(resolveDbConfig().kind).toBe("postgres");
    });
  });

  it("uses SQLite only locally, or when asked for explicitly", async () => {
    await withEnv({ ...NOT_HOSTED, NODE_ENV: "development", DATABASE_URL: undefined, SKYLINE_DB_DRIVER: undefined }, () => {
      expect(resolveDbConfig().kind).toBe("sqlite");
    });
    await withEnv({ ...NOT_HOSTED, NODE_ENV: "production", DATABASE_URL: undefined, SKYLINE_DB_DRIVER: "sqlite" }, () => {
      expect(resolveDbConfig().kind).toBe("sqlite");
    });
    await withEnv({ ...NOT_HOSTED, NODE_ENV: "development", DATABASE_URL: undefined, SKYLINE_DB_DRIVER: "mysql" }, () => {
      expect(reason(resolveDbConfig)).toContain("SKYLINE_DB_DRIVER");
    });
  });

  it("refuses SQLite on a serverless host, whatever else is set", async () => {
    for (const hosted of [{ AWS_LAMBDA_FUNCTION_NAME: "fn" }, { LAMBDA_TASK_ROOT: "/var/task" }, { NETLIFY: "true" }]) {
      await withEnv({ ...NOT_HOSTED, ...hosted, NODE_ENV: "production", DATABASE_URL: undefined, SKYLINE_DB_DRIVER: "sqlite" }, () => {
        expect(isServerless()).toBe(true);
        expect(reason(resolveDbConfig)).toContain("serverless");
      });
      await withEnv({ ...NOT_HOSTED, ...hosted, NODE_ENV: "development", DATABASE_URL: undefined, SKYLINE_DB_DRIVER: undefined }, () => {
        expect(reason(resolveDbConfig)).toContain("serverless");
      });
    }
  });
});

describe("queries and transactions", () => {
  it("passes values as parameters, so SQL in a value is only text", async () => {
    const hostile = "Robert'); DROP TABLE members; --";
    const created = await createMember(member(1, { name: hostile }), staff.admin);
    expect((await listMembers()).map((m) => m.name)).toEqual([hostile]);
    expect(await get<{ name: string }>("SELECT name FROM members WHERE id = ?", created.id)).toEqual({ name: hostile });
    expect(await get("SELECT id FROM members WHERE name = ?", "x' OR '1'='1")).toBeUndefined();
  });

  it("returns counts and flags as plain numbers on both databases", async () => {
    await createMember(member(1), staff.admin);
    const row = await get<{ n: number; total: number; flag: number }>(
      "SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total, CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS flag FROM transactions",
    );
    expect(row).toEqual({ n: 1, total: 50000, flag: 1 });
    expect((await run("UPDATE members SET phone = ? WHERE email = ?", "123", "member1@campus.example")).changes).toBe(1);
    expect((await run("UPDATE members SET phone = ? WHERE email = ?", "123", "nobody@campus.example")).changes).toBe(0);
  });

  it("rolls everything back when a transaction fails, including nested ones", async () => {
    const attempt = tx(async () => {
      await run("UPDATE users SET name = ? WHERE id = ?", "Changed", staff.admin.id);
      await tx(async () => {
        await run("UPDATE users SET name = ? WHERE id = ?", "Changed too", staff.treasurer.id);
      });
      throw new AppError("boom", "stop", 400);
    });
    await expect(attempt).rejects.toMatchObject({ code: "boom" });
    expect((await all<{ name: string }>("SELECT name FROM users ORDER BY name")).map((u) => u.name)).toEqual(["Admin", "Organizer", "Treasurer"]);
  });

  it("commits what a transaction did, and sees its own writes inside it", async () => {
    const seen = await tx(async () => {
      await run("UPDATE users SET name = ? WHERE id = ?", "Renamed", staff.admin.id);
      return (await get<{ name: string }>("SELECT name FROM users WHERE id = ?", staff.admin.id))!.name;
    });
    expect(seen).toBe("Renamed");
    expect((await get<{ name: string }>("SELECT name FROM users WHERE id = ?", staff.admin.id))!.name).toBe("Renamed");
  });

  it("gives every member a different number when many join at the same moment", async () => {
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => createMember(member(i + 1), staff.admin)));
    const numbers = created.map((m) => m.memberNo).sort();
    expect(new Set(numbers).size).toBe(12);
    expect(numbers[0]).toBe("SKY-M-0001");
    expect(numbers[11]).toBe("SKY-M-0012");
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM transactions WHERE category = 'dues'"))!.n).toBe(12);
  });

  it("lets only one of several simultaneous sign-ups for an email through, and reports the rest cleanly", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        createUser({ email: "Dup@Test.Example", name: "Dup", role: "organizer", password: "password-1" }).then(
          () => "created",
          (error: unknown) => (error instanceof AppError ? error.code : "unexpected"),
        ),
      ),
    );
    expect(results.filter((r) => r === "created")).toHaveLength(1);
    expect(results.filter((r) => r === "email_taken")).toHaveLength(5);
  });

  it("lets only one of two simultaneous check-in undos succeed", async () => {
    const event = await publishedEvent(staff, { priceCents: 0, memberPriceCents: 0 });
    const ticket = await registerForEvent(event.id, person(1));
    await checkIn({ code: ticket.code, eventId: event.id, collectPayment: false, method: "cash" }, staff.organizer);
    const results = await Promise.all(
      [1, 2].map(() =>
        undoCheckIn(ticket.code, staff.organizer).then(
          () => "undone",
          (error: unknown) => (error instanceof AppError ? error.code : "unexpected"),
        ),
      ),
    );
    expect(results.sort()).toEqual(["not_checked_in", "undone"]);
  });

  it("treats emails as case-insensitive for lookups and uniqueness", async () => {
    await createMember(member(1, { email: "Mixed.Case@Campus.Example" }), staff.admin);
    expect(await get("SELECT 1 AS found FROM members WHERE email = ?", "MIXED.CASE@campus.example")).toEqual({ found: 1 });
    await expect(
      run(
        "INSERT INTO members (id, member_no, name, email, joined_on, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        "mem_dup",
        "SKY-M-9999",
        "Dup",
        "MIXED.CASE@CAMPUS.EXAMPLE",
        "2026-01-01",
        "2026-01-01T00:00:00.000Z",
      ),
    ).rejects.toThrow();
  });

  it("enforces foreign keys, checks and the one-open-application rule in the database itself", async () => {
    await expect(run("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", "h", "usr_missing", "x", "x")).rejects.toThrow();
    await expect(run("UPDATE users SET role = ? WHERE id = ?", "owner", staff.admin.id)).rejects.toThrow();
    const application = (id: string, code: string, status: string, reference: string) =>
      run(
        `INSERT INTO membership_applications (id, code, name, email, amount_cents, payment_method, payment_reference, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, code, "A", "a@campus.example", 50000, "upi", reference, status, "2026-01-01T00:00:00.000Z",
      );
    await application("app_1", "APP-AAAAAA", "rejected", "REF1");
    await application("app_2", "APP-BBBBBB", "pending", "REF2");
    await expect(application("app_3", "APP-CCCCCC", "pending", "REF3")).rejects.toThrow(); // second open one for the email
    await expect(application("app_4", "APP-DDDDDD", "approved", "REF2")).rejects.toThrow(); // reference already used
    await application("app_5", "APP-EEEEEE", "approved", "REF1"); // a rejected application frees its reference
  });
});

describe("sessions", () => {
  it("survive the connection being closed and reopened, and end only on sign-out or expiry", async () => {
    const session = await login("admin@test.example", "password-1");
    expect((await getSessionUser(session.token))?.role).toBe("admin");
    await closeDb();
    expect((await getSessionUser(session.token))?.email).toBe("admin@test.example");
    expect(await getSessionUser("not-a-real-token")).toBeNull();
    // Only a hash is stored.
    expect(JSON.stringify(await all("SELECT * FROM sessions"))).not.toContain(session.token);
    await logout(session.token);
    expect(await getSessionUser(session.token)).toBeNull();
  });
});

describe("the first administrator", () => {
  beforeEach(async () => {
    await wipeAllData();
  });

  it("is the only account on a new database, and is not created by anything else", async () => {
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n).toBe(0);
    const admin = await createFirstAdmin({ email: " First.Admin@Club.Example ", name: "First Admin", password: "a-long-first-password" });
    expect(admin).toMatchObject({ email: "first.admin@club.example", role: "admin" });
    expect((await login("first.admin@club.example", "a-long-first-password")).user.role).toBe("admin");
    const stored = JSON.stringify(await all("SELECT * FROM users"));
    expect(stored).not.toContain("a-long-first-password");
  });

  it("refuses to add a second administrator unless told to", async () => {
    await createFirstAdmin({ email: "one@club.example", name: "One", password: "a-long-first-password" });
    expect((await appError(() => createFirstAdmin({ email: "two@club.example", name: "Two", password: "another-long-password" }))).code).toBe("admin_exists");
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n).toBe(1);
    await createFirstAdmin({ email: "two@club.example", name: "Two", password: "another-long-password" }, { allowAdditional: true });
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"))!.n).toBe(2);
  });

  it("rejects a short password and a malformed email, creating nothing", async () => {
    expect((await appError(() => createFirstAdmin({ email: "a@club.example", name: "A", password: "x".repeat(ADMIN_PASSWORD_MIN - 1) }))).status).toBe(422);
    expect((await appError(() => createFirstAdmin({ email: "not-an-email", name: "Someone", password: "a-long-first-password" }))).status).toBe(422);
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n).toBe(0);
  });
});

describe("resetting an administrator's password", () => {
  it("changes that one account, ends its sessions, and creates nothing", async () => {
    const before = await all<{ id: string; email: string; role: string }>("SELECT id, email, role FROM users ORDER BY email");
    const session = await login("admin@test.example", "password-1");
    const treasurerHash = (await get<{ h: string }>("SELECT password_hash AS h FROM users WHERE id = ?", staff.treasurer.id))!.h;

    const result = await resetAdminPassword(" Admin@Test.Example ", "a-brand-new-long-password");
    expect(result).toMatchObject({ email: "admin@test.example", sessionsEnded: 1 });

    expect(await getSessionUser(session.token)).toBeNull();
    expect((await appError(() => login("admin@test.example", "password-1"))).status).toBe(401);
    expect((await login("admin@test.example", "a-brand-new-long-password")).user).toMatchObject({ id: staff.admin.id, role: "admin" });
    // Same accounts as before, and nobody else's password moved.
    expect(await all("SELECT id, email, role FROM users ORDER BY email")).toEqual(before);
    expect((await get<{ h: string }>("SELECT password_hash AS h FROM users WHERE id = ?", staff.treasurer.id))!.h).toBe(treasurerHash);
    expect(JSON.stringify(await all("SELECT * FROM users"))).not.toContain("a-brand-new-long-password");
  });

  it("refuses an unknown email, a non-administrator and a short password, changing nothing", async () => {
    const hashes = () => all<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users ORDER BY id");
    const before = await hashes();
    expect((await appError(() => resetAdminPassword("nobody@test.example", "a-brand-new-long-password"))).code).toBe("no_such_account");
    expect((await appError(() => resetAdminPassword("treasurer@test.example", "a-brand-new-long-password"))).code).toBe("not_an_admin");
    expect((await appError(() => resetAdminPassword("admin@test.example", "x".repeat(ADMIN_PASSWORD_MIN - 1)))).code).toBe("weak_password");
    expect(await hashes()).toEqual(before);
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n).toBe(3);
  });
});

describe("a treasurer account", () => {
  const create = (overrides: Record<string, string> = {}) =>
    createCommitteeAccount({ email: "New.Treasurer@Club.Example", name: "New Treasurer", role: "treasurer", password: "a-long-treasurer-password", ...overrides });

  it("is created with the treasurer role, can sign in, and changes no other account", async () => {
    const before = await all("SELECT id, email, role, password_hash FROM users ORDER BY email");
    const created = await create();
    expect(created).toMatchObject({ email: "new.treasurer@club.example", role: "treasurer", memberId: null });

    const session = await login("new.treasurer@club.example", "a-long-treasurer-password");
    expect(session.user).toMatchObject({ id: created.id, role: "treasurer" });
    expect((await getSessionUser(session.token))?.role).toBe("treasurer");
    // The accounts that were there before are exactly as they were.
    expect(await all("SELECT id, email, role, password_hash FROM users WHERE id <> ? ORDER BY email", created.id)).toEqual(before);
    expect(JSON.stringify(await all("SELECT * FROM users"))).not.toContain("a-long-treasurer-password");
  });

  it("can do the finance, membership and merchandise work a treasurer is for", async () => {
    const treasurer = await create();
    const entry = await createTransaction(
      transactionInputSchema.parse({ type: "income", category: "donation", amountCents: 25000, occurredOn: today(), description: "Alumni gift", status: "settled", method: "bank" }),
      treasurer,
    );
    expect(entry).toMatchObject({ amountCents: 25000, status: "settled" });
    // Members come to exist through applications the treasurer reviews; adding one by hand is the president's.
    expect((await appError(() => createMember(member(1), treasurer))).status).toBe(403);
    expect(await listApplications(treasurer)).toEqual([]);
    const product = await createProduct(
      productInputSchema.parse({ name: "Cap", priceCents: 30000, memberPriceCents: 25000, variants: [{ size: "M", stock: 2 }] }),
      treasurer,
    );
    expect((await setStockLevels(product.id, [{ variantId: product.variants[0].id, stock: 9 }], treasurer)).variants[0].stock).toBe(9);
  });

  it("cannot do what belongs to the president and organizers", async () => {
    const treasurer = await create();
    expect((await appError(() => createEvent(eventInput(), treasurer))).status).toBe(403);
    expect((await appError(() => createAnnouncement({ title: "Hello", body: "A notice for everyone.", audience: "everyone" }, treasurer))).status).toBe(403);
    const event = await publishedEvent(staff, { priceCents: 0, memberPriceCents: 0 });
    const ticket = await registerForEvent(event.id, person(1));
    // The door is not the treasurer's either.
    expect((await appError(() => checkIn({ code: ticket.code, eventId: event.id, collectPayment: false, method: "cash" }, treasurer))).status).toBe(403);
    expect((await appError(() => undoCheckIn(ticket.code, treasurer))).status).toBe(403);
    expect((await appError(() => setEventStatus(event.id, "cancelled", treasurer))).status).toBe(403);
    // Nor can the account be turned into, or used to reset, an administrator.
    expect((await appError(() => resetAdminPassword("new.treasurer@club.example", "another-long-password"))).code).toBe("not_an_admin");
  });

  it("cannot be used to create an administrator, a duplicate or a weak account", async () => {
    for (const role of ["admin", "member", "owner", ""]) {
      expect((await appError(() => create({ role, email: `x-${role || "none"}@club.example` }))).status).toBe(422);
    }
    await create();
    expect((await appError(() => create({ email: "NEW.TREASURER@club.example" }))).code).toBe("email_taken");
    expect((await appError(() => create({ email: "admin@test.example" }))).code).toBe("email_taken");
    expect((await appError(() => create({ email: "short@club.example", password: "x".repeat(ADMIN_PASSWORD_MIN - 1) }))).code).toBe("weak_password");
    expect((await appError(() => create({ email: "not-an-email" }))).status).toBe(422);
    const roles = await all<{ role: string; n: number }>("SELECT role, COUNT(*) AS n FROM users GROUP BY role ORDER BY role");
    expect(roles).toEqual([{ role: "admin", n: 1 }, { role: "organizer", n: 1 }, { role: "treasurer", n: 2 }]);
    expect((await create({ email: "organizer2@club.example", role: "organizer" })).role).toBe("organizer");
  });
});

describe("rate limiting", () => {
  const limit = { name: "test-bucket", max: 3, windowMs: 60_000 };
  const hit = (address: string | null) => enforceRateLimit(limit, address);
  let bypass: string | undefined;
  beforeEach(() => {
    bypass = process.env.SKYLINE_DISABLE_RATE_LIMIT;
    delete process.env.SKYLINE_DISABLE_RATE_LIMIT;
  });
  afterEach(() => {
    if (bypass !== undefined) process.env.SKYLINE_DISABLE_RATE_LIMIT = bypass;
  });

  it("allows up to the limit and then refuses, per client and per bucket", async () => {
    for (let i = 0; i < 3; i++) await hit("203.0.113.7");
    expect(await appError(() => hit("203.0.113.7"))).toMatchObject({ code: "rate_limited", status: 429 });
    await hit("203.0.113.8"); // another client is unaffected
    await enforceRateLimit({ ...limit, name: "other-bucket" }, "203.0.113.7"); // so is another bucket
  });

  it("counts simultaneous requests exactly", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => hit("198.51.100.1").then(() => "ok", () => "limited")),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(3);
    expect(results.filter((r) => r === "limited")).toHaveLength(7);
  });

  it("starts again once the window has passed", async () => {
    for (let i = 0; i < 4; i++) await hit("198.51.100.2").catch(() => undefined);
    await run("UPDATE rate_limits SET reset_at = ? WHERE bucket_key LIKE ?", Date.now() - 1, "test-bucket:%");
    await hit("198.51.100.2");
    expect((await get<{ count: number }>("SELECT count FROM rate_limits WHERE bucket_key LIKE ?", "test-bucket:%"))!.count).toBe(1);
  });

  it("is shared through the database, not held in the process, and stores no address", async () => {
    for (let i = 0; i < 3; i++) await hit("192.0.2.55");
    await closeDb(); // a different server instance would see the same rows
    expect((await appError(() => hit("192.0.2.55"))).code).toBe("rate_limited");
    expect(JSON.stringify(await all("SELECT * FROM rate_limits"))).not.toContain("192.0.2.55");
  });

  it("can be bypassed locally for the end-to-end script", async () => {
    process.env.SKYLINE_DISABLE_RATE_LIMIT = "1";
    for (let i = 0; i < 10; i++) await hit("192.0.2.99");
  });
});

describe("uploads", () => {
  it("come back byte for byte, and only through the database record", async () => {
    const id = await storeImage(PNG, "claim_receipt");
    const file = await openFile(id);
    expect(file.mime).toBe("image/png");
    expect(Buffer.compare(file.bytes, PNG)).toBe(0);
    expect(await storedFileIds()).toEqual([id]);
    expect((await appError(() => openFile("../../etc/passwd"))).status).toBe(404);
    expect((await appError(() => openFile("fil_doesnotexist1"))).status).toBe(404);
  });

  it("leave nothing behind when the surrounding transaction fails", async () => {
    let id = "";
    await expect(
      tx(async () => {
        id = await storeImage(PNG, "claim_receipt");
        throw new AppError("boom", "stop", 400);
      }),
    ).rejects.toMatchObject({ code: "boom" });
    expect(await get("SELECT 1 FROM files WHERE id = ?", id)).toBeUndefined();
    if (onPostgres) expect(await storedFileIds()).toEqual([]);
  });

  it("are kept in the database, not on disk, when that is asked for", async () => {
    await withEnv({ SKYLINE_UPLOADS: "database" }, async () => {
      const id = await storeImage(PNG, "product_image");
      expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM file_contents WHERE file_id = ?", id))!.n).toBe(1);
      expect(fs.existsSync(path.join(process.env.SKYLINE_UPLOAD_DIR!, id))).toBe(false);
      expect(Buffer.compare((await openFile(id)).bytes, PNG)).toBe(0);
    });
  });
});

describe("an unavailable database", () => {
  it("becomes a 503 that says nothing about the cause", async () => {
    const error = new DatabaseUnavailableError("connection failed (ECONNREFUSED)");
    const quiet = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    let response: Response;
    try {
      response = failure("POST", "/api/auth/login", error);
    } finally {
      console.error = quiet;
    }
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body).error.code).toBe("database_unavailable");
    expect(body).not.toContain("ECONNREFUSED");
    expect(logged.join("\n")).toContain("database unavailable: connection failed (ECONNREFUSED)");
    expect(isDatabaseUnavailable(error)).toBe(true);
    expect(isDatabaseUnavailable(new Error("other"))).toBe(false);
  });

  it("keeps an ordinary failure a 500 with no detail", async () => {
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const response = failure("GET", "/api/x", new Error("relation secret_table does not exist"));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("secret_table");
    } finally {
      console.error = quiet;
    }
  });
});

describe("placeholders", () => {
  it("are numbered for PostgreSQL, leaving quoted question marks alone", () => {
    expect(toPostgresSql("SELECT * FROM t WHERE a = ? AND b = ?")).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
    expect(toPostgresSql("SELECT '?' AS q, x FROM t WHERE y = ? AND z = 'why?'")).toBe("SELECT '?' AS q, x FROM t WHERE y = $1 AND z = 'why?'");
    expect(toPostgresSql("SELECT 1")).toBe("SELECT 1");
  });
});

describe.runIf(onPostgres)("PostgreSQL only", () => {
  const url = () => process.env.DATABASE_URL!;
  const sibling = (database: string) => url().replace(/\/[^/]+$/, `/${database}`);

  it("is what these tests are running on", async () => {
    expect(await dbKind()).toBe("postgres");
    expect((await get<{ v: string }>("SELECT version() AS v"))!.v).toMatch(/^PostgreSQL 1[5-9]/);
  });

  it("records each migration once, and running them again changes nothing", async () => {
    const recorded = await all<{ version: number; name: string }>("SELECT version, name FROM schema_migrations ORDER BY version");
    expect(recorded.map((r) => r.version)).toEqual(POSTGRES_MIGRATIONS.map((m) => m.version));
    expect(recorded.at(-1)!.version).toBe(POSTGRES_SCHEMA_VERSION);
    expect(await migratePostgres(url())).toEqual({ before: POSTGRES_SCHEMA_VERSION, after: POSTGRES_SCHEMA_VERSION, applied: [] });
    expect((await migratePostgres(url(), { dryRun: true })).applied).toEqual([]);
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_migrations"))!.n).toBe(POSTGRES_MIGRATIONS.length);
  });

  it("upgrades a version-1 database that already holds records, in order, without touching them", async () => {
    // The state of production before this build: only the baseline applied, with real rows in it.
    const name = `skyline_upgrade_${Date.now()}`;
    await run(`CREATE DATABASE ${name}`);
    const pg = (await import("pg")).default;
    const direct = new pg.Client({ connectionString: sibling(name) });
    await direct.connect();
    const snapshot = async () => ({
      users: (await direct.query("SELECT id, email, name, role, password_hash, created_at FROM users ORDER BY id")).rows,
      ledger: (await direct.query("SELECT id, type, category, amount_cents, status, occurred_on, description, source, created_by, created_at, settled_at FROM transactions ORDER BY id")).rows,
      tasks: (await direct.query("SELECT id, title, assignee, status, created_by, created_at FROM tasks ORDER BY id")).rows,
    });
    try {
      await direct.query(MIGRATIONS_TABLE);
      await direct.query(POSTGRES_MIGRATIONS[0].sql);
      await direct.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, $1, $2)", [POSTGRES_MIGRATIONS[0].name, "2026-10-10T19:36:07.999Z"]);
      await direct.query("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES ('usr_1', 'president@test.example', 'President', 'admin', 'scrypt$00$00', '2026-10-10T19:39:40.000Z')");
      await direct.query(
        `INSERT INTO transactions (id, type, category, amount_cents, status, occurred_on, description, source, created_by, created_at, settled_at)
         VALUES ('txn_1', 'income', 'fundraiser', 1000000, 'settled', '2026-10-11', 'Fundraiser', 'manual', 'usr_1', '2026-10-10T21:10:50.834Z', '2026-10-10T21:10:50.834Z')`,
      );
      await direct.query("INSERT INTO tasks (id, title, assignee, status, created_by, created_at) VALUES ('tsk_1', 'Organise students', 'A volunteer', 'in_progress', 'usr_1', '2026-10-10T21:15:13.201Z')");
      const before = await snapshot();

      const dry = await migratePostgres(sibling(name), { dryRun: true });
      expect(dry).toMatchObject({ before: 1, after: 1 });
      expect(dry.applied.map((m) => m.version)).toEqual(POSTGRES_MIGRATIONS.slice(1).map((m) => m.version));
      expect(await snapshot()).toEqual(before);
      // This build refuses a database that is behind, rather than half-working on it.
      await expect(openPostgres(sibling(name))).rejects.toMatchObject({ reason: expect.stringContaining("schema is at version 1") });

      const real = await migratePostgres(sibling(name));
      expect(real).toMatchObject({ before: 1, after: POSTGRES_SCHEMA_VERSION });
      expect(real.applied.map((m) => m.version)).toEqual([2, 3, 4, 5]);
      expect((await direct.query("SELECT member_id FROM users")).rows).toEqual([{ member_id: null }]);
      expect((await direct.query("SELECT COUNT(*)::int AS n FROM staff_setup_tokens")).rows).toEqual([{ n: 0 }]);
      expect(await snapshot()).toEqual(before);
      // The new columns arrive with the values that mean "as before": not open to volunteers, not disabled.
      expect((await direct.query("SELECT volunteer_slots FROM tasks")).rows).toEqual([{ volunteer_slots: 0 }]);
      expect((await direct.query("SELECT disabled_at FROM users")).rows).toEqual([{ disabled_at: null }]);
      expect((await direct.query("SELECT COUNT(*)::int AS n FROM volunteer_requests")).rows).toEqual([{ n: 0 }]);
      expect((await direct.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);
      const upgraded = await openPostgres(sibling(name));
      await upgraded.close();
    } finally {
      await direct.end();
      await run(`DROP DATABASE ${name} WITH (FORCE)`);
    }
  });

  it("builds the whole schema on an empty database, and a dry run builds nothing", async () => {
    const name = `skyline_empty_${Date.now()}`;
    await run(`CREATE DATABASE ${name}`);
    try {
      const dry = await migratePostgres(sibling(name), { dryRun: true });
      expect(dry).toMatchObject({ before: 0, after: 0 });
      expect(dry.applied.map((m) => m.version)).toEqual(POSTGRES_MIGRATIONS.map((m) => m.version));
      const real = await migratePostgres(sibling(name));
      expect(real).toMatchObject({ before: 0, after: POSTGRES_SCHEMA_VERSION });
      const fresh = await openPostgres(sibling(name));
      const tables = (await fresh.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'", [], true)).rows.map((r) => r.table_name);
      await fresh.close();
      expect(tables.sort()).toEqual([...EXPECTED_TABLES, "schema_migrations"].sort());
    } finally {
      await run(`DROP DATABASE ${name} WITH (FORCE)`);
    }
  });

  it("has the same tables, columns and required-ness as the SQLite schema", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skyline-parity-"));
    const sqlite = await openSqlite(path.join(dir, "parity.db"));
    try {
      for (const table of EXPECTED_TABLES) {
        const lite = (await sqlite.query(`PRAGMA table_info(${table})`, [], true)).rows as { name: string; notnull: number; pk: number }[];
        const pgColumns = await all<{ column_name: string; is_nullable: string }>(
          "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
          table,
        );
        expect(pgColumns.map((c) => c.column_name).sort(), table).toEqual(lite.map((c) => c.name).sort());
        for (const column of lite) {
          const required = column.notnull === 1 || column.pk > 0;
          expect(pgColumns.find((c) => c.column_name === column.name)!.is_nullable, `${table}.${column.name}`).toBe(required ? "NO" : "YES");
        }
      }
      const liteIndexes = ((await sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'", [], true)).rows as { name: string }[]).map((r) => r.name);
      const pgIndexes = (await all<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")).map((r) => r.indexname);
      for (const index of liteIndexes) expect(pgIndexes, index).toContain(index);
    } finally {
      await sqlite.close();
    }
  });

  it("has every uniqueness rule that money and identity depend on", async () => {
    const indexes = await all<{ indexname: string; indexdef: string }>("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'");
    for (const name of CRITICAL_UNIQUE_INDEXES) {
      const index = indexes.find((i) => i.indexname === name);
      expect(index?.indexdef, name).toMatch(/^CREATE UNIQUE INDEX .* WHERE /);
    }
    const unique = new Set(
      (await all<{ t: string; c: string }>(
        `SELECT c.conrelid::regclass::text AS t, a.attname AS c
         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
         WHERE c.contype IN ('u','p') AND array_length(c.conkey, 1) = 1`,
      )).map((r) => `${r.t}.${r.c}`),
    );
    for (const [table, column] of CRITICAL_UNIQUE_COLUMNS) expect(unique, `${table}.${column}`).toContain(`${table}.${column}`);
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace"))!.n).toBeGreaterThanOrEqual(44);
  });

  it("runs write transactions one at a time, across separate connections", async () => {
    const events: string[] = [];
    const slow = tx(async () => {
      events.push("first:start");
      await run("UPDATE users SET name = name WHERE id = ?", staff.admin.id);
      await new Promise((resolve) => setTimeout(resolve, 250));
      events.push("first:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = tx(async () => {
      events.push("second:start");
    });
    // A plain read is not held up by the open write transaction.
    const read = get("SELECT 1 AS ok").then(() => events.push("read"));
    await Promise.all([slow, second, read]);
    expect(events).toEqual(["first:start", "read", "first:end", "second:start"]);
    const locks = await all("SELECT 1 FROM pg_locks WHERE locktype = 'advisory'");
    expect(locks).toHaveLength(0); // released at commit
  });

  it("reports an unreachable server, a missing database and an unmigrated one as unavailable, without credentials", async () => {
    const unreachable = url().replace(/@127\.0\.0\.1:\d+\//, "@127.0.0.1:9/");
    for (const target of [unreachable, sibling("no_such_database"), sibling("postgres")]) {
      const error = await openPostgres(target).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isDatabaseUnavailable(error), target.replace(/:[^:@]+@/, ":***@")).toBe(true);
      const text = `${(error as DatabaseUnavailableError).reason} ${(error as Error).message}`;
      expect(text).not.toContain("skyline-local-test");
      expect(text).not.toContain("postgres://");
    }
    const unmigrated = (await openPostgres(sibling("postgres")).catch((e: unknown) => e)) as DatabaseUnavailableError;
    expect(unmigrated.reason).toContain("schema is at version 0");
  });

  it("stores upload bytes in the database", async () => {
    const id = await storeImage(PNG, "product_image");
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM file_contents WHERE file_id = ?", id))!.n).toBe(1);
    expect(fs.readdirSync(process.env.SKYLINE_UPLOAD_DIR!)).toEqual([]);
  });

  it("ignores the rate-limit bypass on a serverless host", async () => {
    await withEnv({ SKYLINE_DISABLE_RATE_LIMIT: "1", AWS_LAMBDA_FUNCTION_NAME: "skyline-fn" }, async () => {
      const limit = { name: "hosted", max: 2, windowMs: 60_000 };
      await enforceRateLimit(limit, "203.0.113.200");
      await enforceRateLimit(limit, "203.0.113.200");
      expect((await appError(() => enforceRateLimit(limit, "203.0.113.200"))).code).toBe("rate_limited");
    });
  });
});
