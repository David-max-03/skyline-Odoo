import { createHash } from "node:crypto";
import { get, run } from "./db";
import { isServerless } from "./db/config";
import { AppError } from "./errors";

/**
 * Request rate limiting, counted in the database so a limit holds across
 * every server instance. (An in-memory counter is per process: on a
 * serverless host each instance would have its own, and a limit of ten would
 * really be ten per instance.)
 *
 * Fixed window per bucket and client. The client is the visitor's address
 * (or, for the per-account sign-in limit, the email or member ID typed),
 * stored only as a hash. One atomic statement counts the request and reports
 * the total, so two simultaneous requests cannot both be "the tenth".
 */

export interface RateLimit {
  /** Bucket name; limits are per bucket per client address. */
  name: string;
  max: number;
  windowMs: number;
}

/**
 * The bypass exists for the end-to-end script, which signs in dozens of times
 * from one address. It is ignored on a serverless host, so it cannot switch
 * limits off in production even if the variable is set there by mistake.
 */
const bypassed = () => process.env.SKYLINE_DISABLE_RATE_LIMIT === "1" && !isServerless();

export async function enforceRateLimit(limit: RateLimit, clientAddress: string | null): Promise<void> {
  if (bypassed()) return;
  const client = createHash("sha256").update(clientAddress || "local").digest("hex").slice(0, 32);
  const key = `${limit.name}:${client}`;
  const nowMs = Date.now();

  const row = await get<{ count: number }>(
    `INSERT INTO rate_limits (bucket_key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT (bucket_key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
     RETURNING count`,
    key,
    nowMs + limit.windowMs,
    nowMs,
    nowMs,
  );

  // Now and then, clear out windows that ended long ago, so the table stays small.
  if (Math.random() < 0.02) {
    await run("DELETE FROM rate_limits WHERE reset_at < ?", nowMs - 24 * 3_600_000).catch(() => undefined);
  }

  if ((row?.count ?? 1) > limit.max) {
    const minutes = Math.ceil(limit.windowMs / 60_000);
    throw new AppError(
      "rate_limited",
      minutes <= 1 ? "Too many attempts. Wait a minute and try again." : `Too many attempts. Try again in ${minutes} minutes.`,
      429,
    );
  }
}

/**
 * Sign-in attempts allowed for one email or member ID, whatever address they
 * come from. This is what slows guessing one account's password from many
 * addresses, which the per-address limit cannot.
 *
 * - It counts every attempt for the identifier as typed, whether or not an
 *   account with it exists, and answers the same way for both: it reveals
 *   nothing about which emails are accounts.
 * - It is a fixed window, so it always lifts by itself after 15 minutes.
 *   Nobody is locked out for good, and nothing is written to the account.
 */
export const SIGN_IN_ACCOUNT_LIMIT: RateLimit = { name: "login-account", max: 10, windowMs: 15 * 60_000 };

export function enforceSignInAccountLimit(identifier: string): Promise<void> {
  return enforceRateLimit(SIGN_IN_ACCOUNT_LIMIT, `account:${identifier.trim().toLowerCase()}`);
}
