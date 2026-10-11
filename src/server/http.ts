import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { shopperMember, type Role, type SessionUser } from "@/lib/contracts";
import { SESSION_COOKIE, getSessionUser } from "./auth";
import { isDatabaseUnavailable } from "./db/types";
import { AppError, forbidden, unauthorized } from "./errors";
import { enforceRateLimit, type RateLimit } from "./rate-limit";

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
  /** The submitted form, for routes declared with `form`. Files are read from here. */
  form: FormData | null;
  params: Record<string, string>;
  query: URLSearchParams;
}
export type StaffContext<B> = BaseContext<B> & { user: SessionUser };
export type MemberContext<B> = BaseContext<B> & { user: SessionUser; memberId: string };
export type PublicContext<B> = BaseContext<B> & { user: SessionUser | null };

interface Options<S extends z.ZodType | undefined> {
  body?: S;
  /**
   * Accept a multipart form instead of JSON. The text fields are validated
   * with `body`; files are read from `ctx.form`. Requests larger than
   * `maxBytes` are refused before the body is read.
   */
  form?: { maxBytes: number };
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
      // Member accounts are never staff, including on routes open to every staff role.
      if (user.role === "member") throw forbidden("This area is for committee accounts.");
      if (roles && !(roles as readonly string[]).includes(user.role)) throw forbidden();
    },
  );
}

/**
 * Route for a signed-in member acting on their own records. `ctx.memberId`
 * comes from the session; handlers must use it rather than any id in the request.
 */
export function memberRoute<S extends z.ZodType | undefined = undefined>(
  options: Options<S>,
  handler: (ctx: MemberContext<BodyOf<S>>) => unknown,
): RouteHandler {
  return build(
    options,
    (ctx) => handler({ ...ctx, memberId: ctx.user!.memberId! } as MemberContext<BodyOf<S>>),
    (user) => {
      if (!user) throw unauthorized();
      if (user.role !== "member" || !user.memberId) {
        throw forbidden("Sign in with a member account to use this.");
      }
    },
  );
}

/**
 * Route for buying merchandise as a member: a signed-in member, or a committee
 * account that is linked to a member record, acting as that member. A
 * committee account with no member record is refused; it can still order as a
 * guest. `ctx.memberId` comes from the session, never from the request.
 */
export function shopperRoute<S extends z.ZodType | undefined = undefined>(
  options: Options<S>,
  handler: (ctx: MemberContext<BodyOf<S>>) => unknown,
): RouteHandler {
  return build(
    options,
    (ctx) => handler({ ...ctx, memberId: shopperMember(ctx.user)!.id } as MemberContext<BodyOf<S>>),
    (user) => {
      if (!user) throw unauthorized();
      if (!shopperMember(user)) {
        throw forbidden(
          user.role === "member"
            ? "Sign in with a member account to use this."
            : "Your committee account is not linked to a member record, so it cannot order or pay as a member.",
        );
      }
    },
  );
}

/** Route anyone may call. `ctx.user` is set when a staff or member session is present. */
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
      if (options.limit) await enforceRateLimit(options.limit, clientAddress(req));

      const user = await getSessionUser(req.cookies.get(SESSION_COOKIE)?.value);
      authorise?.(user);

      let body: unknown = undefined;
      let form: FormData | null = null;
      if (options.form) form = await readForm(req, options.form.maxBytes);
      if (options.body) {
        let raw: unknown;
        if (form) {
          raw = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string"));
        } else {
          try {
            raw = await req.json();
          } catch {
            throw new AppError("invalid_json", "The request body must be valid JSON.", 400);
          }
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
        form,
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
      return failure(req.method, req.nextUrl.pathname, error);
    }
  };
}

/**
 * Reads a multipart form. The declared length is checked first, so an
 * oversized upload is refused without buffering it.
 */
async function readForm(req: NextRequest, maxBytes: number): Promise<FormData> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    throw new AppError("invalid_form", "Send this request as a form.", 415);
  }
  const length = Number(req.headers.get("content-length") ?? Number.NaN);
  if (!Number.isFinite(length)) {
    throw new AppError("length_required", "The request must state its size.", 411);
  }
  if (length > maxBytes) {
    throw new AppError("too_large", "That upload is too large.", 413);
  }
  try {
    return await req.formData();
  } catch {
    throw new AppError("invalid_form", "The form could not be read.", 400);
  }
}

/**
 * The reply for an unexpected failure. A database that is not configured, not
 * reachable or not migrated is a 503, with a reason in the server log that
 * never includes a connection string. Nothing about the cause reaches the client.
 */
export function failure(method: string, pathname: string, error: unknown): Response {
  if (isDatabaseUnavailable(error)) {
    console.error(`[api] ${method} ${pathname}: database unavailable: ${error.reason}`);
    return json(
      { error: { code: "database_unavailable", message: "The service is temporarily unavailable. Try again shortly." } },
      503,
    );
  }
  console.error(`[api] ${method} ${pathname} failed`, error);
  return json({ error: { code: "internal", message: "Something went wrong on the server." } }, 500);
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
// Counted in the database (see rate-limit.ts), so a limit holds across server instances.

/**
 * The visitor's address, for rate limiting only.
 *
 * On Netlify the address is in `x-nf-client-connection-ip`, the one header
 * Netlify says it sets for this. `X-Forwarded-For` is a list the client can
 * start with anything it likes, so its first entry is never used: where the
 * Netlify header is absent (a local server behind a proxy), the last entry is
 * taken, which is the one written by the proxy nearest this server.
 *
 * This is a best effort, not an identity. The sign-in limit per account
 * (`signIn` in auth.ts) does not depend on it.
 */
export function clientAddress(req: { headers: { get(name: string): string | null } }): string | null {
  const netlify = req.headers.get("x-nf-client-connection-ip")?.trim();
  if (netlify) return netlify;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
  return forwarded.at(-1) ?? null;
}

export const LIMITS = {
  login: { name: "login", max: 10, windowMs: 60_000 },
  publicWrite: { name: "public-write", max: 30, windowMs: 60_000 },
  /** Uploads from people without an account: few are ever legitimate from one address. */
  application: { name: "application", max: 6, windowMs: 10 * 60_000 },
  passwordSetup: { name: "password-setup", max: 10, windowMs: 60_000 },
  /** Starting an online application creates an order with the payment provider. */
  onlineStart: { name: "online-start", max: 10, windowMs: 10 * 60_000 },
  onlineAction: { name: "online-action", max: 60, windowMs: 60_000 },
  ticketLookup: { name: "ticket-lookup", max: 60, windowMs: 60_000 },
} as const satisfies Record<string, RateLimit>;
