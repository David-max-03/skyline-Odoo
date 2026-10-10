import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eventInputSchema, type EventInput, type SessionUser } from "@/lib/contracts";
import { createUser } from "@/server/auth";
import { closeDb, now, setClock, wipeAllData } from "@/server/db";
import { AppError } from "@/server/errors";
import { createEvent, setEventStatus } from "@/server/services/events";

export interface Staff {
  admin: SessionUser;
  treasurer: SessionUser;
  organizer: SessionUser;
}

/** True when this run is against PostgreSQL (`npm run test:pg`) instead of a temporary SQLite file. */
export const onPostgres = process.env.SKYLINE_TEST_DB === "postgres";

/**
 * Gives the test an empty database and one account per role.
 *
 * On SQLite that is a brand-new temporary file. On PostgreSQL it is the
 * disposable server started by `scripts/with-postgres.ts`, emptied table by
 * table; that server is local and never a real database.
 */
export async function freshDb(): Promise<Staff> {
  setClock(null);
  // Uploads always go to a throwaway folder, never to the project's own data/uploads.
  process.env.SKYLINE_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skyline-test-uploads-"));
  if (onPostgres) {
    if (!/@127\.0\.0\.1:\d+\/skyline_test$/.test(process.env.DATABASE_URL ?? "")) {
      throw new Error("Refusing to run tests: DATABASE_URL is not the disposable local test database.");
    }
    await wipeAllData();
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skyline-test-"));
    await closeDb();
    process.env.SKYLINE_DB_PATH = path.join(dir, "test.db");
  }
  return {
    admin: await createUser({ email: "admin@test.example", name: "Admin", role: "admin", password: "password-1" }),
    treasurer: await createUser({ email: "treasurer@test.example", name: "Treasurer", role: "treasurer", password: "password-1" }),
    organizer: await createUser({ email: "organizer@test.example", name: "Organizer", role: "organizer", password: "password-1" }),
  };
}

const hours = (n: number) => new Date(now().getTime() + n * 3_600_000).toISOString();

export function eventInput(overrides: Partial<Record<keyof EventInput, unknown>> = {}): EventInput {
  return eventInputSchema.parse({
    title: "Test Event",
    description: "",
    venue: "Hall A",
    startsAt: hours(24),
    endsAt: hours(27),
    capacity: 50,
    priceCents: 50000,
    memberPriceCents: 40000,
    profitTargetCents: null,
    ...overrides,
  });
}

export async function publishedEvent(staff: Staff, overrides: Partial<Record<keyof EventInput, unknown>> = {}) {
  const event = await createEvent(eventInput(overrides), staff.organizer);
  return (await setEventStatus(event.id, "published", staff.organizer)).event;
}

export const person = (n: number) => ({
  name: `Student ${n}`,
  email: `student${n}@campus.example`,
  studentId: null,
  memberNo: null,
});

/** Runs `fn` and returns the AppError it throws; fails the test if it does not throw one. */
export async function appError(fn: () => unknown): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("Expected an AppError, but nothing was thrown");
}
