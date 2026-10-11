import { randomBytes } from "node:crypto";
import {
  CAN,
  ROLES,
  STAFF_PASSWORD_MIN,
  type AccountAction,
  type AccountCreateInput,
  type CommitteeAccount,
  type CommitteeAccountCreated,
  type CommitteeSetupLink,
  type Role,
  type SessionUser,
  type StaffSetupInfo,
} from "@/lib/contracts";
import { SETUP_LINK_HOURS, createUser, hashPassword, hashToken } from "./auth";
import { all, get, newId, now, nowIso, run, tx } from "./db";
import { AppError, conflict, forbidden, invalid, notFound, requireRole } from "./errors";

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
//
// Every function here checks the caller's role, and every change re-reads the
// caller inside its transaction: a president who was disabled or demoted a
// moment ago is refused, so two presidents acting on each other at once cannot
// both succeed. A president cannot disable or demote their own account, and
// nobody else can act at all, so one usable president always remains.
// ---------------------------------------------------------------------------

/**
 * Stored instead of a password hash until the person sets a password with
 * their setup link. It is not a hash, so no password can ever match it.
 */
export const NO_PASSWORD = "unset";

interface AccountRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  created_at: string;
  disabled_at: string | null;
  setup_pending: number | boolean;
  member_no: string | null;
}

const ACCOUNT_SELECT = `
  SELECT u.id, u.email, u.name, u.role, u.created_at, u.disabled_at,
         CASE WHEN u.password_hash = '${NO_PASSWORD}' THEN 1 ELSE 0 END AS setup_pending,
         m.member_no
  FROM users u LEFT JOIN members m ON m.id = u.member_id`;

const toAccount = (row: AccountRow, viewer: SessionUser): CommitteeAccount => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  createdAt: row.created_at,
  disabledAt: row.disabled_at,
  setupPending: Number(row.setup_pending) === 1,
  memberNo: row.member_no,
  isYou: row.id === viewer.id,
});

const accountById = async (id: string, viewer: SessionUser): Promise<CommitteeAccount> => {
  const row = await get<AccountRow>(`${ACCOUNT_SELECT} WHERE u.id = ?`, id);
  if (!row) throw notFound("Account");
  return toAccount(row, viewer);
};

/** Inside a transaction: the caller must still be an active president with a password of their own. */
async function assertStillPresident(user: SessionUser): Promise<void> {
  const row = await get(
    `SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND disabled_at IS NULL AND password_hash <> '${NO_PASSWORD}'`,
    user.id,
  );
  if (!row) throw forbidden();
}

/**
 * Refuses a change that would leave no president able to sign in. The rules
 * about one's own account already guarantee this; it is checked on its own so
 * the guarantee does not depend on them.
 */
async function assertAnotherPresident(exceptId: string): Promise<void> {
  const others = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users
     WHERE role = 'admin' AND disabled_at IS NULL AND password_hash <> '${NO_PASSWORD}' AND id <> ?`,
    exceptId,
  );
  if ((others?.n ?? 0) < 1) {
    throw conflict("last_president", "This is the only active president. Make someone else president first.");
  }
}

export async function listCommitteeAccounts(actor: SessionUser | null | undefined): Promise<CommitteeAccount[]> {
  const user = requireRole(actor, ...CAN.manageAccounts);
  const rows = await all<AccountRow>(`${ACCOUNT_SELECT} ORDER BY (u.disabled_at IS NOT NULL), u.created_at, u.id`);
  return rows.map((row) => toAccount(row, user));
}

/** Makes a one-time setup link for an account, cancelling any earlier unused one. Call inside a transaction. */
async function newStaffSetupLink(
  account: { id: string; name: string; email: string; role: Role },
  createdBy: string,
): Promise<CommitteeSetupLink> {
  await run("DELETE FROM staff_setup_tokens WHERE user_id = ? AND used_at IS NULL", account.id);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now().getTime() + SETUP_LINK_HOURS * 3_600_000).toISOString();
  await run(
    `INSERT INTO staff_setup_tokens (token_hash, user_id, expires_at, used_at, created_by, created_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
    hashToken(token),
    account.id,
    expiresAt,
    createdBy,
    nowIso(),
  );
  return { path: `/committee-setup/${token}`, expiresAt, name: account.name, email: account.email, role: account.role };
}

/**
 * The president adds a committee account: for a new person, or for an existing
 * member (`memberId`).
 *
 * No password is chosen here and none is shown. The account is created unable
 * to sign in, and the reply carries a one-time link with which the person sets
 * their own password.
 *
 * Promoting a member creates only the committee account, linked to the member
 * by `users.member_id`. The member row, its number, terms, tickets, orders and
 * payments are not written to, and the member's own sign-in keeps working with
 * the password it already has.
 */
export async function inviteCommitteeAccount(
  input: AccountCreateInput,
  actor: SessionUser | null | undefined,
): Promise<CommitteeAccountCreated> {
  const user = requireRole(actor, ...CAN.manageAccounts);
  if (!(ROLES as readonly string[]).includes(input.role)) throw invalid("Choose a committee role.", { role: "Choose a committee role" });
  return tx(async () => {
    await assertStillPresident(user);

    let name: string;
    let email: string;
    let memberId: string | null = null;
    if (input.memberId) {
      const member = await get<{ id: string; name: string; email: string }>(
        "SELECT id, name, email FROM members WHERE id = ?",
        input.memberId,
      );
      if (!member) throw notFound("Member");
      if (await get("SELECT 1 FROM users WHERE member_id = ?", member.id)) {
        throw conflict("already_committee", `${member.name} already has a committee account. Change its role instead.`);
      }
      ({ name, email } = member);
      email = email.toLowerCase();
      memberId = member.id;
    } else {
      name = (input.name ?? "").trim();
      email = (input.email ?? "").trim().toLowerCase();
      if (name.length < 2) throw invalid("Enter the person's full name.", { name: "Enter the person's full name" });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid("Enter a valid email address.", { email: "Enter a valid email address" });
      const member = await get<{ member_no: string }>("SELECT member_no FROM members WHERE email = ?", email);
      if (member) {
        throw conflict(
          "member_email",
          `This email belongs to member ${member.member_no}. Use "Existing member" so the two stay linked.`,
        );
      }
    }
    if (await get("SELECT 1 FROM users WHERE email = ?", email)) {
      throw conflict("email_taken", "A committee account with this email already exists.");
    }

    const id = newId("usr");
    await run(
      "INSERT INTO users (id, email, name, role, password_hash, created_at, member_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      email,
      name,
      input.role,
      NO_PASSWORD,
      nowIso(),
      memberId,
    );
    const setupLink = await newStaffSetupLink({ id, name, email, role: input.role }, user.id);
    return { account: await accountById(id, user), setupLink };
  });
}

/**
 * The president changes another account's role. Every session of that account
 * is ended, so the next thing it does happens under the new role.
 */
export async function setCommitteeAccountRole(
  id: string,
  role: Role,
  actor: SessionUser | null | undefined,
): Promise<CommitteeAccount> {
  const user = requireRole(actor, ...CAN.manageAccounts);
  if (!(ROLES as readonly string[]).includes(role)) throw invalid("Choose a committee role.", { role: "Choose a committee role" });
  return tx(async () => {
    await assertStillPresident(user);
    const target = await get<{ role: Role }>("SELECT role FROM users WHERE id = ?", id);
    if (!target) throw notFound("Account");
    if (id === user.id) {
      throw conflict("own_account", "You cannot change your own role. Another president has to do it.");
    }
    if (target.role === role) throw conflict("same_role", "This account already has that role.");
    if (target.role === "admin") await assertAnotherPresident(id);
    const changed = await run("UPDATE users SET role = ? WHERE id = ? AND role = ?", role, id, target.role);
    if (changed.changes !== 1) throw conflict("changed", "This account changed while you were editing it. Reload and try again.");
    await run("DELETE FROM sessions WHERE user_id = ?", id);
    return accountById(id, user);
  });
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
    await assertStillPresident(user);
    const target = await get<{ role: Role }>("SELECT role FROM users WHERE id = ?", id);
    if (!target) throw notFound("Account");

    if (action === "disable") {
      if (id === user.id) {
        throw conflict("own_account", "You cannot disable your own account. Another president has to do it.");
      }
      if (target.role === "admin") await assertAnotherPresident(id);
      const changed = await run("UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL", nowIso(), id);
      if (changed.changes !== 1) throw conflict("already_disabled", "This account is already disabled.");
      await run("DELETE FROM sessions WHERE user_id = ?", id);
      await run("DELETE FROM staff_setup_tokens WHERE user_id = ? AND used_at IS NULL", id);
    } else {
      const changed = await run("UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL", id);
      if (changed.changes !== 1) throw conflict("not_disabled", "This account is already active.");
    }
    return accountById(id, user);
  });
}

/**
 * The president issues a new setup link for a treasurer or an event handler:
 * for someone who never used theirs, or who has forgotten their password. Any
 * earlier unused link stops working. The current password keeps working until
 * the link is used.
 *
 * Never for another president who already has a password: a link would let its
 * holder take that account over. (A president who was invited and has not set
 * a password yet has nothing to take over, so their invitation can be re-sent.)
 * A president who has lost their password is reset from the command line.
 */
export async function issueCommitteeSetupLink(
  id: string,
  actor: SessionUser | null | undefined,
): Promise<CommitteeSetupLink> {
  const user = requireRole(actor, ...CAN.manageAccounts);
  return tx(async () => {
    await assertStillPresident(user);
    const target = await get<{ id: string; name: string; email: string; role: Role; disabled_at: string | null; password_hash: string }>(
      "SELECT id, name, email, role, disabled_at, password_hash FROM users WHERE id = ?",
      id,
    );
    if (!target) throw notFound("Account");
    if (id === user.id) throw conflict("own_account", "This is your own account. You are already signed in to it.");
    if (target.role === "admin" && target.password_hash !== NO_PASSWORD) {
      throw forbidden("A password link cannot be created for another president.");
    }
    if (target.disabled_at) throw conflict("account_disabled", "This account is disabled. Enable it first.");
    return newStaffSetupLink({ id: target.id, name: target.name, email: target.email, role: target.role }, user.id);
  });
}

// ---------------------------------------------------------------------------
// Using a committee setup link (no session: the link is the proof)
// ---------------------------------------------------------------------------

const badStaffLink = () =>
  new AppError("invalid_link", "This link is not valid. It may have expired or already been used.", 400);

/** Tells the holder of a link whose account it sets up. Changes nothing. */
export async function inspectStaffSetupToken(token: string): Promise<StaffSetupInfo> {
  const row = await get<{ name: string; email: string; role: Role; expires_at: string }>(
    `SELECT u.name, u.email, u.role, t.expires_at
     FROM staff_setup_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.disabled_at IS NULL`,
    hashToken(token),
    nowIso(),
  );
  if (!row) throw badStaffLink();
  return { name: row.name, email: row.email, role: row.role, expiresAt: row.expires_at };
}

/**
 * Sets the account's password and spends the link. The UPDATE's WHERE clause
 * is the guard: of two requests with the same link, only one changes a row.
 * A disabled account's link does nothing. Existing sessions are ended.
 */
export async function completeStaffSetup(token: string, password: string): Promise<{ email: string }> {
  return tx(async () => {
    const tokenHash = hashToken(token);
    const ts = nowIso();
    const spent = await run(
      "UPDATE staff_setup_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
      ts,
      tokenHash,
      ts,
    );
    if (spent.changes !== 1) throw badStaffLink();
    const account = await get<{ id: string; email: string; name: string }>(
      `SELECT u.id, u.email, u.name FROM staff_setup_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND u.disabled_at IS NULL`,
      tokenHash,
    );
    if (!account) throw badStaffLink();

    // A failed check throws, which rolls the transaction back and leaves the link usable.
    if (password.length < STAFF_PASSWORD_MIN) {
      throw invalid("Choose a longer password.", { password: `Use at least ${STAFF_PASSWORD_MIN} characters` });
    }
    const lowered = password.toLowerCase();
    if (lowered === account.email.toLowerCase() || lowered === account.name.toLowerCase()) {
      throw invalid("Choose a different password.", { password: "Do not use your email or name as your password" });
    }
    await run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), account.id);
    await run("DELETE FROM sessions WHERE user_id = ?", account.id);
    return { email: account.email };
  });
}
