import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { MEMBER_PASSWORD_MIN, type Role, type SessionUser, type SetupTokenInfo } from "@/lib/contracts";
import { get, newId, now, nowIso, run, tx } from "./db";
import { AppError, conflict, invalid, notFound } from "./errors";

/**
 * Password hashing, server-side sessions and password-setup links.
 *
 * The browser only ever holds an opaque random token in an httpOnly cookie.
 * The database stores its SHA-256, so a leaked database does not leak usable
 * sessions. The account's role is read from the database on every request.
 *
 * There are two kinds of account. Staff live in `users` and hold a staff role.
 * Members live in `member_accounts` and always get the role "member". The two
 * have separate session tables, so a member session cannot resolve to a staff
 * role whatever else goes wrong.
 */

export const SESSION_COOKIE = "skyline_session";
export const SESSION_DAYS = 7;
/** How long a password-setup link stays valid. */
export const SETUP_LINK_HOURS = 72;

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Verified against when the account is unknown, so every attempt costs the same.
const DUMMY_HASH = hashPassword(randomBytes(12).toString("hex"));

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Member tokens carry a prefix so a lookup only ever touches one session table.
const MEMBER_TOKEN_PREFIX = "m.";

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
}

interface MemberAccountRow {
  id: string;
  member_no: string;
  name: string;
  email: string;
  password_hash: string;
}

const toSessionUser = (row: UserRow): SessionUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  memberId: null,
  memberNo: null,
});

const toMemberSession = (row: Omit<MemberAccountRow, "password_hash">): SessionUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: "member",
  memberId: row.id,
  memberNo: row.member_no,
});

export function createUser(input: {
  email: string;
  name: string;
  role: Role;
  password: string;
}): SessionUser {
  const email = input.email.trim().toLowerCase();
  if (input.password.length < 8) {
    throw new AppError("weak_password", "Password must be at least 8 characters.", 422);
  }
  if (get("SELECT 1 FROM users WHERE email = ?", email)) {
    throw conflict("email_taken", "An account with this email already exists.");
  }
  const id = newId("usr");
  run(
    "INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    email,
    input.name.trim(),
    input.role,
    hashPassword(input.password),
    nowIso(),
  );
  return { id, email, name: input.name.trim(), role: input.role, memberId: null, memberNo: null };
}

export function countUsers(): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;
}

export interface LoginResult {
  user: SessionUser;
  token: string;
  expiresAt: Date;
}

const MEMBER_NO = /^SKY-M-\d{1,9}$/i;

/**
 * Signs in a staff account (by email) or a member account (by email or member
 * ID). Both password checks always run, so the response time does not reveal
 * which kind of account exists, and the error is the same for every failure.
 */
export function login(identifier: string, password: string): LoginResult {
  const id = identifier.trim();
  const byMemberNo = MEMBER_NO.test(id);

  const staff = byMemberNo
    ? undefined
    : get<UserRow>("SELECT * FROM users WHERE email = ?", id.toLowerCase());
  const member = get<MemberAccountRow>(
    `SELECT m.id, m.member_no, m.name, m.email, a.password_hash
     FROM member_accounts a JOIN members m ON m.id = a.member_id
     WHERE ${byMemberNo ? "m.member_no = ?" : "m.email = ?"}`,
    byMemberNo ? id.toUpperCase() : id.toLowerCase(),
  );

  const staffOk = verifyPassword(password, staff?.password_hash ?? DUMMY_HASH) && !!staff;
  const memberOk = verifyPassword(password, member?.password_hash ?? DUMMY_HASH) && !!member;
  if (!staffOk && !memberOk) {
    throw new AppError("invalid_credentials", "Those sign-in details are not correct.", 401);
  }

  const expiresAt = new Date(now().getTime() + SESSION_DAYS * 86_400_000);
  const ts = nowIso();
  run("DELETE FROM sessions WHERE expires_at < ?", ts);
  run("DELETE FROM member_sessions WHERE expires_at < ?", ts);

  // An email that is both a staff login and a member login signs in as staff
  // when the staff password matches.
  if (staffOk && staff) {
    const token = randomBytes(32).toString("base64url");
    run(
      "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      hashToken(token),
      staff.id,
      expiresAt.toISOString(),
      ts,
    );
    return { user: toSessionUser(staff), token, expiresAt };
  }

  const token = MEMBER_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  run(
    "INSERT INTO member_sessions (token_hash, member_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    hashToken(token),
    member!.id,
    expiresAt.toISOString(),
    ts,
  );
  return { user: toMemberSession(member!), token, expiresAt };
}

export function getSessionUser(token: string | null | undefined): SessionUser | null {
  if (!token) return null;
  if (token.startsWith(MEMBER_TOKEN_PREFIX)) {
    // The join on member_accounts means removing an account ends its sessions' access too.
    const row = get<Omit<MemberAccountRow, "password_hash">>(
      `SELECT m.id, m.member_no, m.name, m.email
       FROM member_sessions s
       JOIN members m ON m.id = s.member_id
       JOIN member_accounts a ON a.member_id = m.id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      hashToken(token),
      nowIso(),
    );
    return row ? toMemberSession(row) : null;
  }
  const row = get<UserRow>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    hashToken(token),
    nowIso(),
  );
  return row ? toSessionUser(row) : null;
}

export function logout(token: string | null | undefined): void {
  if (!token) return;
  const table = token.startsWith(MEMBER_TOKEN_PREFIX) ? "member_sessions" : "sessions";
  run(`DELETE FROM ${table} WHERE token_hash = ?`, hashToken(token));
}

/** Refuses a password that is too short or is one of the member's own identifiers. */
function assertMemberPassword(password: string, member: { email: string; member_no: string }, field: string): void {
  if (password.length < MEMBER_PASSWORD_MIN) {
    throw invalid("Choose a longer password.", { [field]: `Use at least ${MEMBER_PASSWORD_MIN} characters` });
  }
  const lowered = password.toLowerCase();
  if (lowered === member.email.toLowerCase() || lowered === member.member_no.toLowerCase()) {
    throw invalid("Choose a different password.", { [field]: "Do not use your email or member ID as your password" });
  }
}

/**
 * A signed-in member changes their own password. The current password must be
 * given, and every other session for the member is ended; the session making
 * the change (`currentToken`) stays signed in.
 */
export function changeMemberPassword(
  memberId: string,
  currentPassword: string,
  newPassword: string,
  currentToken: string | null | undefined,
): void {
  tx(() => {
    const member = get<MemberAccountRow>(
      `SELECT m.id, m.member_no, m.name, m.email, a.password_hash
       FROM member_accounts a JOIN members m ON m.id = a.member_id WHERE m.id = ?`,
      memberId,
    );
    if (!member) throw notFound("Account");
    if (!verifyPassword(currentPassword, member.password_hash)) {
      throw invalid("Your current password is not correct.", { currentPassword: "This is not your current password" });
    }
    assertMemberPassword(newPassword, member, "newPassword");
    if (verifyPassword(newPassword, member.password_hash)) {
      throw invalid("Choose a different password.", { newPassword: "This is the same as your current password" });
    }
    run(
      "UPDATE member_accounts SET password_hash = ?, password_set_at = ? WHERE member_id = ?",
      hashPassword(newPassword),
      nowIso(),
      memberId,
    );
    run(
      "DELETE FROM member_sessions WHERE member_id = ? AND token_hash <> ?",
      memberId,
      currentToken ? hashToken(currentToken) : "",
    );
  });
}

// ---------------------------------------------------------------------------
// Password-setup links
//
// A link carries 32 random bytes. Only its SHA-256 is stored. It works once,
// expires after SETUP_LINK_HOURS, and issuing a new link for a member revokes
// any earlier unused one. Callers must authorise before issuing a link.
// ---------------------------------------------------------------------------

const badLink = () =>
  new AppError("invalid_link", "This link is not valid. It may have expired or already been used.", 400);

export function createSetupToken(
  memberId: string,
  createdBy: string | null,
): { token: string; expiresAt: string } {
  return tx(() => {
    if (!get("SELECT 1 FROM members WHERE id = ?", memberId)) throw notFound("Member");
    run("DELETE FROM account_setup_tokens WHERE member_id = ? AND used_at IS NULL", memberId);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now().getTime() + SETUP_LINK_HOURS * 3_600_000).toISOString();
    run(
      `INSERT INTO account_setup_tokens (token_hash, member_id, expires_at, used_at, created_by, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
      hashToken(token),
      memberId,
      expiresAt,
      createdBy,
      nowIso(),
    );
    return { token, expiresAt };
  });
}

/** Tells the holder of a link whose account it sets up. Changes nothing. */
export function inspectSetupToken(token: string): SetupTokenInfo {
  const row = get<{ member_no: string; name: string; expires_at: string }>(
    `SELECT m.member_no, m.name, t.expires_at
     FROM account_setup_tokens t JOIN members m ON m.id = t.member_id
     WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ?`,
    hashToken(token),
    nowIso(),
  );
  if (!row) throw badLink();
  return { memberNo: row.member_no, name: row.name, expiresAt: row.expires_at };
}

/**
 * Sets the member's password and spends the link. The UPDATE's WHERE clause is
 * the guard: of two requests with the same link, only one can change a row.
 * Existing sessions for the member are ended, so a reset signs old devices out.
 */
export function completeSetup(token: string, password: string): { memberNo: string } {
  return tx(() => {
    const tokenHash = hashToken(token);
    const ts = nowIso();
    const spent = run(
      "UPDATE account_setup_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
      ts,
      tokenHash,
      ts,
    );
    if (spent.changes !== 1) throw badLink();

    const member = get<{ id: string; member_no: string; email: string }>(
      `SELECT m.id, m.member_no, m.email
       FROM account_setup_tokens t JOIN members m ON m.id = t.member_id
       WHERE t.token_hash = ?`,
      tokenHash,
    );
    if (!member) throw badLink();

    // A failed check throws, which rolls the transaction back and leaves the link usable.
    assertMemberPassword(password, member, "password");

    run(
      `INSERT INTO member_accounts (member_id, password_hash, password_set_at, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET
         password_hash = excluded.password_hash,
         password_set_at = excluded.password_set_at`,
      member.id,
      hashPassword(password),
      ts,
      ts,
    );
    run("DELETE FROM member_sessions WHERE member_id = ?", member.id);
    return { memberNo: member.member_no };
  });
}
