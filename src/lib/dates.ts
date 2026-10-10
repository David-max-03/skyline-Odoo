/**
 * Date conventions
 * - Timestamps are ISO-8601 UTC strings ("2026-10-10T05:30:00.000Z").
 * - Calendar dates (due dates, expiry, transaction dates) are "YYYY-MM-DD"
 *   strings interpreted in the organisation's timezone.
 */

export const ORG_TZ = process.env.NEXT_PUBLIC_ORG_TZ || "Asia/Kolkata";
const LOCALE = process.env.NEXT_PUBLIC_LOCALE || "en-IN";

/** The calendar date of an instant in the organisation's timezone. */
export function ymdInTz(date: Date, timeZone: string = ORG_TZ): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function ymdToUtc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(ymd: string, days: number): string {
  return new Date(ymdToUtc(ymd) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((ymdToUtc(to) - ymdToUtc(from)) / 86_400_000);
}

export function isYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = ymdToUtc(value);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** "10 Oct 2026" from a calendar date. Never shifts across timezones. */
export function formatDate(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(ymdToUtc(ymd.slice(0, 10))));
}

/** "Sat, 10 Oct 2026, 6:30 pm" from a timestamp. */
export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** "10 Oct, 6:30 pm" from a timestamp. */
export function formatShortDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
}

/** "Oct 2026" from "2026-10". */
export function formatMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", month: "short", year: "2-digit" }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

/** Timestamp → value for <input type="datetime-local"> in the browser's zone. */
export function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Value of <input type="datetime-local"> → ISO timestamp, or null if empty/invalid. */
export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
