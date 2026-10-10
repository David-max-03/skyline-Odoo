import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Role, SessionUser } from "@/lib/contracts";
import { get, newId, now, nowIso, run } from "./db";
import { AppError, conflict } from "./errors";

/**
 * Password hashing and server-side sessions.
 *
 * The browser only ever holds an opaque random token in an httpOnly cookie.
 * The database stores its SHA-256, so a leaked database does not leak usable
 * sessions. The user's role is read from the `users` row on every request.
 */

export const SESSION_COOKIE = "skyline_session";
export const SESSION_DAYS = 7;

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

// Verified against when the email is unknown, so both paths cost one scrypt.
const DUMMY_HASH = hashPassword(randomBytes(12).toString("hex"));

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
}

const toSessionUser = (row: UserRow): SessionUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
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
  return { id, email, name: input.name.trim(), role: input.role };
}

export function countUsers(): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;
}

export interface LoginResult {
  user: SessionUser;
  token: string;
  expiresAt: Date;
}

export function login(email: string, password: string): LoginResult {
  const row = get<UserRow>("SELECT * FROM users WHERE email = ?", email.trim().toLowerCase());
  const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) {
    throw new AppError("invalid_credentials", "Email or password is incorrect.", 401);
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now().getTime() + SESSION_DAYS * 86_400_000);
  run("DELETE FROM sessions WHERE expires_at < ?", nowIso());
  run(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    hashToken(token),
    row.id,
    expiresAt.toISOString(),
    nowIso(),
  );
  return { user: toSessionUser(row), token, expiresAt };
}

export function getSessionUser(token: string | null | undefined): SessionUser | null {
  if (!token) return null;
  const row = get<UserRow>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    hashToken(token),
    nowIso(),
  );
  return row ? toSessionUser(row) : null;
}

export function logout(token: string | null | undefined): void {
  if (token) run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
}
