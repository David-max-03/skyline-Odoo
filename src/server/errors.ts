import type { Role, SessionUser } from "@/lib/contracts";

/**
 * The one error type services throw for expected failures. The HTTP layer
 * turns it into `{ error: { code, message, fields } }` with `status`.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError("not_found", `${what} was not found.`, 404);

export const unauthorized = () => new AppError("unauthorized", "Sign in to continue.", 401);

export const forbidden = (message = "Your role does not allow this action.") =>
  new AppError("forbidden", message, 403);

export const conflict = (code: string, message: string) => new AppError(code, message, 409);

export const invalid = (message: string, fields?: Record<string, string>) =>
  new AppError("invalid", message, 422, fields);

/**
 * Authorisation check used inside services, so a rule holds no matter which
 * route (or script) calls the service. Returns the actor for convenience.
 */
export function requireRole(actor: SessionUser | null | undefined, ...roles: Role[]): SessionUser {
  if (!actor) throw unauthorized();
  if (!roles.includes(actor.role)) throw forbidden();
  return actor;
}
