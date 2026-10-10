import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eventInputSchema, type EventInput, type SessionUser } from "@/lib/contracts";
import { createUser } from "@/server/auth";
import { closeDb, now, setClock } from "@/server/db";
import { AppError } from "@/server/errors";
import { createEvent, setEventStatus } from "@/server/services/events";

export interface Staff {
  admin: SessionUser;
  treasurer: SessionUser;
  organizer: SessionUser;
}

/** Points the app at a new, empty database file and creates one account per role. */
export function freshDb(): Staff {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skyline-test-"));
  closeDb();
  setClock(null);
  process.env.SKYLINE_DB_PATH = path.join(dir, "test.db");
  delete process.env.ANTHROPIC_API_KEY;
  return {
    admin: createUser({ email: "admin@test.example", name: "Admin", role: "admin", password: "password-1" }),
    treasurer: createUser({ email: "treasurer@test.example", name: "Treasurer", role: "treasurer", password: "password-1" }),
    organizer: createUser({ email: "organizer@test.example", name: "Organizer", role: "organizer", password: "password-1" }),
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

export function publishedEvent(staff: Staff, overrides: Partial<Record<keyof EventInput, unknown>> = {}) {
  const event = createEvent(eventInput(overrides), staff.organizer);
  return setEventStatus(event.id, "published", staff.organizer).event;
}

export const person = (n: number) => ({
  name: `Student ${n}`,
  email: `student${n}@campus.example`,
  studentId: null,
  memberNo: null,
});

/** Runs `fn` and returns the AppError it throws; fails the test if it does not throw one. */
export function appError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("Expected an AppError, but nothing was thrown");
}
