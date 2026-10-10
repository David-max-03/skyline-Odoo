import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import type { Role, SessionUser } from "@/lib/contracts";
import { SESSION_COOKIE, getSessionUser } from "./auth";
import { AppError, forbidden, unauthorized } from "./errors";

/**
 * Route wrapper used by every handler in `src/app/api`.
 *
 * It resolves the session, enforces roles, checks the request origin on
 * mutations, validates the JSON body, applies an optional rate limit, and
 * turns results and errors into the standard envelope:
 *
 *   200 { "data": ... }
 *   4xx { "error": { "code", "message", "fields"? } }
 */

interface BaseContext<B> {
  req: NextRequest;
  body: B;
  params: Record<string, string>;
  query: URLSearchParams;
}
export type StaffContext<B> = BaseContext<B> & { user: SessionUser };
export type PublicContext<B> = BaseContext<B> & { user: SessionUser | null };

interface RateLimit {
  /** Bucket name; limits are per bucket per client address. */
  name: string;
  max: number;
  windowMs: number;
}

interface Options<S extends z.ZodType | undefined> {
  body?: S;
  limit?: RateLimit;
}

type BodyOf<S> = S extends z.ZodType ? z.output<S> : undefined;
type RouteArgs = { params: Promise<Record<string, string | string[] | undefined>> };
type RouteHandler = (req: NextRequest, args: RouteArgs) => Promise<Response>;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Staff-only route. `roles` omitted means any signed-in staff account. */
export function staffRoute<S extends z.ZodType | undefined = undefined>(
  roles: readonly Role[] | null,
  options: Options<S>,
  handler: (ctx: StaffContext<BodyOf<S>>) => unknown,
): RouteHandler {
  return build(
    options,
    (ctx) => handler(ctx as StaffContext<BodyOf<S>>),
    (user) => {
      if (!user) throw unauthorized();
      if (roles && !roles.includes(user.role)) throw forbidden();
    },
  );
}

/** Route anyone may call. `ctx.user` is set when a staff session is present. */
export function publicRoute<S extends z.ZodType | undefined = undefined>(
  options: Options<S>,
  handler: (ctx: PublicContext<BodyOf<S>>) => unknown,
): RouteHandler {
  return build(options, handler);
}

function build<S extends z.ZodType | undefined>(
  options: Options<S>,
  handler: (ctx: PublicContext<BodyOf<S>>) => unknown,
  /** Runs before the body is read, so callers without access learn nothing about the input shape. */
  authorise?: (user: SessionUser | null) => void,
): RouteHandler {
  return async (req, args) => {
    try {
      if (MUTATING.has(req.method)) assertSameOrigin(req);
      if (options.limit) enforceLimit(req, options.limit);

      const user = getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
      authorise?.(user);

      let body: unknown = undefined;
      if (options.body) {
        let raw: unknown;
        try {
          raw = await req.json();
        } catch {
          throw new AppError("invalid_json", "The request body must be valid JSON.", 400);
        }
        const parsed = options.body.safeParse(raw);
        if (!parsed.success) {
          const fields: Record<string, string> = {};
          for (const issue of parsed.error.issues) {
            const key = issue.path.join(".") || "_";
            fields[key] ??= issue.message;
          }
          throw new AppError("invalid", "Check the highlighted fields and try again.", 422, fields);
        }
        body = parsed.data;
      }

      const rawParams = (await args.params) ?? {};
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawParams)) {
        if (typeof value === "string") params[key] = value;
      }

      const result = await handler({
        req,
        user,
        body: body as BodyOf<S>,
        params,
        query: req.nextUrl.searchParams,
      });
      if (result instanceof Response) return result;
      return json({ data: result ?? null }, 200);
    } catch (error) {
      if (error instanceof AppError) {
        return json(
          { error: { code: error.code, message: error.message, fields: error.fields } },
          error.status,
        );
      }
      console.error(`[api] ${req.method} ${req.nextUrl.pathname} failed`, error);
      return json(
        { error: { code: "internal", message: "Something went wrong on the server." } },
        500,
      );
    }
  };
}

function json(body: unknown, status: number): Response {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Browsers attach `Origin` to cross-site POSTs. Refusing a mismatched origin,
 * together with the SameSite=Lax session cookie, blocks cross-site request
 * forgery. Non-browser clients that send no Origin are unaffected.
 */
function assertSameOrigin(req: NextRequest): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError("bad_origin", "Cross-site requests are not allowed.", 403);
  }
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host"), req.nextUrl.host];
  if (!hosts.includes(originHost)) {
    throw new AppError("bad_origin", "Cross-site requests are not allowed.", 403);
  }
}

// --- rate limiting -----------------------------------------------------------
// In-memory fixed window. Enough to blunt brute force and form spam on a
// single-process deployment; it resets when the server restarts.

const globalBuckets = globalThis as unknown as {
  __skylineBuckets?: Map<string, { count: number; resetAt: number }>;
};
const buckets = (globalBuckets.__skylineBuckets ??= new Map());

function enforceLimit(req: NextRequest, limit: RateLimit): void {
  if (process.env.SKYLINE_DISABLE_RATE_LIMIT === "1") return;
  const address = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const key = `${limit.name}:${address}`;
  const nowMs = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= nowMs) {
    buckets.set(key, { count: 1, resetAt: nowMs + limit.windowMs });
    if (buckets.size > 5000) {
      for (const [k, b] of buckets) if (b.resetAt <= nowMs) buckets.delete(k);
    }
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit.max) {
    throw new AppError("rate_limited", "Too many attempts. Wait a minute and try again.", 429);
  }
}

export const LIMITS = {
  login: { name: "login", max: 10, windowMs: 60_000 },
  publicWrite: { name: "public-write", max: 30, windowMs: 60_000 },
  ticketLookup: { name: "ticket-lookup", max: 60, windowMs: 60_000 },
  assistant: { name: "assistant", max: 30, windowMs: 60_000 },
} as const satisfies Record<string, RateLimit>;
