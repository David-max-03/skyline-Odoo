/**
 * Money is stored and transmitted as integer minor units (paise, cents).
 * These helpers are the only place that converts to or from display strings.
 */

export const CURRENCY = process.env.NEXT_PUBLIC_CURRENCY || "INR";
export const LOCALE = process.env.NEXT_PUBLIC_LOCALE || "en-IN";

const whole = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: CURRENCY,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const fractional = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: CURRENCY,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Formats minor units, e.g. 125050 → "₹1,250.50", 50000 → "₹500". */
export function formatMoney(cents: number, opts: { signed?: boolean } = {}): string {
  const safe = Number.isFinite(cents) ? Math.round(cents) : 0;
  const abs = Math.abs(safe);
  const text = (abs % 100 === 0 ? whole : fractional).format(abs / 100);
  if (safe < 0) return `−${text}`;
  if (opts.signed && safe > 0) return `+${text}`;
  return text;
}

/**
 * Parses a user-typed amount into minor units without floating point maths.
 * Returns null for anything that is not a non-negative amount with at most
 * two decimal places.
 */
export function parseMoney(input: string): number | null {
  const cleaned = input.replace(/[\s,₹$€£]/g, "");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number((match[2] ?? "").padEnd(2, "0"));
  return major * 100 + minor;
}

/** Minor units → plain decimal string for form inputs, e.g. 125050 → "1250.50". */
export function toInputAmount(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}
