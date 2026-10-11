import { CAN, type AccountAction, type CommitteeAccount, type Role, type SessionUser } from "@/lib/contracts";
import { createUser, hashPassword } from "./auth";
import { all, get, nowIso, run, tx } from "./db";
import { AppError, conflict, forbidden, notFound, requireRole } from "./errors";

/** The first administrator signs everyone else up, so this password gets a higher bar than the general one. */
export const ADMIN_PASSWORD_MIN = 12;

/**
 * Creates the committee's first administrator account. This is the only way
 * an account comes into existence on a new database: there is no default
 * account and nothing is created when the server starts.
 *
 * It refuses when an administrator already exists, so running the command
 * again cannot quietly add another one; `allowAdditional` is the deliberate
 * override. The check and the insert share one transaction.
 */
export async function createFirstAdmin(
  input: { email: string; name: string; password: string },
  options: { allowAdditional?: boolean } = {},
): Promise<SessionUser> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError("invalid", "Enter a valid email address.", 422);
  if (name.length < 2) throw new AppError("invalid", "Enter the administrator's name.", 422);
  if (input.password.length < ADMIN_PASSWORD_MIN) {
    throw new AppError("weak_password", `The password must be at least ${ADMIN_PASSWORD_MIN} characters.`, 422);
  }
  return tx(async () => {
    const existing = await get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
    if ((existing?.n ?? 0) > 0 && !options.allowAdditional) {
      throw conflict("admin_exists", "An administrator account already exists. Nothing was created.");
    }
    return createUser({ email, name, role: "admin", password: input.password });
  });
}

/**
 * Sets a new password for an existing administrator who has lost theirs.
 * Run from the command line by someone with the database connection string;
 * there is deliberately no web route for this.
 *
 * It changes one existing account and nothing else: it never creates an
 * account, and refuses an email that does not exist or is not an
 * administrator. Every session of that account is ended, so anything signed
 * in with the old password is signed out. The new password is hashed the same
 * way as every other password.
 */
export async function resetAdminPassword(
  emailInput: string,
  password: string,
): Promise<{ email: string; name: string; sessionsEnded: number }> {
  const email = emailInput.trim().toLowerCase();
  if (password.length < ADMIN_PASSWORD_MIN) {
    throw new AppError("weak_password", `The password must be at least ${ADMIN_PASSWORD_MIN} characters.`, 422);
  }
  const passwordHash = hashPassword(password);
  return tx(async () => {
    const user = await get<{ id: string; email: string; name: string; role: string }>(
      "SELECT id, email, name, role FROM users WHERE email = ?",
      email,
    );
    if (!user) throw new AppError("no_such_account", "No account has that email. Nothing was changed.", 404);
    if (user.role !== "admin") {
      throw conflict("not_an_admin", "That account is not an administrator. Nothing was changed.");
    }
    const updated = await run("UPDATE users SET password_hash = ? WHERE id = ? AND role = 'admin'", passwordHash, user.id);
    if (updated.changes !== 1) throw conflict("not_an_admin", "The account changed while resetting. Nothing was changed.");
    const ended = await run("DELETE FROM sessions WHERE user_id = ?", user.id);
    return { email: user.email, name: user.name, sessionsEnded: ended.changes };
  });
}

/** The committee roles this can create. An administrator is only ever created by `createFirstAdmin`. */
export const STAFF_ROLES = ["treasurer", "organizer"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * Creates a committee account that is not an administrator: a treasurer or
 * an event organizer. Run from the command line by someone with the database
 * connection string; there is no web route for creating committee accounts.
 *
 * It only ever adds one new account. It cannot create an administrator, it
 * cannot change an existing account's role or password, and an email that is
 * already in use is refused.
 */
export async function createCommitteeAccount(input: {
  email: string;
  name: string;
  role: string;
  password: string;
}): Promise<SessionUser> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!(STAFF_ROLES as readonly string[]).includes(input.role)) {
    throw new AppError("invalid", `The role must be one of: ${STAFF_ROLES.join(", ")}.`, 422);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError("invalid", "Enter a valid email address.", 422);
  if (name.length < 2) throw new AppError("invalid", "Enter the person's name.", 422);
  if (input.password.length < ADMIN_PASSWORD_MIN) {
    throw new AppError("weak_password", `The password must be at least ${ADMIN_PASSWORD_MIN} characters.`, 422);
  }
  return createUser({ email, name, role: input.role as StaffRole, password: input.password });
}

// ---------------------------------------------------------------------------
// Looking after committee accounts (president only)
// ---------------------------------------------------------------------------

interface AccountRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  created_at: string;
  disabled_at: string | null;
}

const ACCOUNT_COLUMNS = "id, email, name, role, created_at, disabled_at";

const toAccount = (row: AccountRow, viewer: SessionUser): CommitteeAccount => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  createdAt: row.created_at,
  disabledAt: row.disabled_at,
  isYou: row.id === viewer.id,
});

export async function listCommitteeAccounts(actor: SessionUser | null | undefined): Promise<CommitteeAccount[]> {
  const user = requireRole(actor, ...CAN.manageAccounts);
  const rows = await all<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM users ORDER BY (disabled_at IS NOT NULL), created_at, id`,
  );
  return rows.map((row) => toAccount(row, user));
}

/**
 * Disables a committee account, or enables it again.
 *
 * Disabling ends every session of the account and stops it signing in. The
 * row is kept, never deleted: ledger entries, reviews and check-ins it made
 * still name the account that made them. Enabling restores sign-in with the
 * password the account already had.
 *
 * A president cannot disable their own account, so there is always at least
 * one active president.
 */
export async function setCommitteeAccountStatus(
  id: string,
  action: AccountAction,
  actor: SessionUser | null | undefined,
): Promise<CommitteeAccount> {
  const user = requireRole(actor, ...CAN.manageAccounts);
  return tx(async () => {
    // Read again inside the transaction: of two presidents disabling each other
    // at the same moment, the second finds itself disabled and is refused.
    if (!await get("SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND disabled_at IS NULL", user.id)) {
      throw forbidden();
    }
    if (!await get("SELECT 1 FROM users WHERE id = ?", id)) throw notFound("Account");

    if (action === "disable") {
      if (id === user.id) {
        throw conflict("own_account", "You cannot disable your own account. Another president has to do it.");
      }
      const changed = await run("UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL", nowIso(), id);
      if (changed.changes !== 1) throw conflict("already_disabled", "This account is already disabled.");
      await run("DELETE FROM sessions WHERE user_id = ?", id);
    } else {
      const changed = await run("UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL", id);
      if (changed.changes !== 1) throw conflict("not_disabled", "This account is already active.");
    }
    return toAccount((await get<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ?`, id))!, user);
  });
}
