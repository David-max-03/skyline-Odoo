import { beforeEach, describe, expect, it } from "vitest";
import {
  MEMBER_PASSWORD_MIN,
  PASSWORD_MIN,
  STAFF_PASSWORD_MIN,
  accountCreateSchema,
  memberInputSchema,
  passwordChangeSchema,
  passwordSetupSchema,
  staffPasswordSetupSchema,
  type Member,
} from "@/lib/contracts";
import {
  ADMIN_PASSWORD_MIN,
  completeStaffSetup,
  createCommitteeAccount,
  createFirstAdmin,
  inviteCommitteeAccount,
  issueCommitteeSetupLink,
  resetAdminPassword,
} from "@/server/admin-setup";
import { changeMemberPassword, completeSetup, createSetupToken, createUser, hashPassword, login } from "@/server/auth";
import { all, run } from "@/server/db";
import { createMember } from "@/server/services/members";
import { appError, freshDb, type Staff } from "./helpers";

/**
 * The password length rule: at least 8 characters, wherever a password is set
 * or changed, and nowhere else. Signing in never looks at length.
 */

let staff: Staff;
let member: Member;

const EIGHT = "k7#mQ2vz"; // exactly the minimum
const SEVEN = "k7#mQ2v"; // one short
const TOKEN = "t".repeat(43);

const hashes = async () => ({
  users: await all<{ id: string; password_hash: string }>("SELECT id, password_hash FROM users ORDER BY id"),
  members: await all<{ member_id: string; password_hash: string; password_set_at: string }>(
    "SELECT member_id, password_hash, password_set_at FROM member_accounts ORDER BY member_id",
  ),
});

beforeEach(async () => {
  staff = await freshDb();
  member = await createMember(memberInputSchema.parse({ name: "Mira Member", email: "mira@campus.example", duesPaid: true }), staff.admin);
});

describe("the minimum password length", () => {
  it("is 8 for every kind of account", () => {
    expect(PASSWORD_MIN).toBe(8);
    expect(MEMBER_PASSWORD_MIN).toBe(8);
    expect(STAFF_PASSWORD_MIN).toBe(8);
    expect(ADMIN_PASSWORD_MIN).toBe(8);
    expect(EIGHT).toHaveLength(8);
    expect(SEVEN).toHaveLength(7);
  });

  it("is what the request validation enforces: 8 accepted, 7 refused, with a message that says 8", () => {
    for (const [schema, body] of [
      [passwordSetupSchema, (password: string) => ({ token: TOKEN, password })],
      [staffPasswordSetupSchema, (password: string) => ({ token: TOKEN, password })],
      [passwordChangeSchema, (password: string) => ({ currentPassword: "whatever it was", newPassword: password })],
    ] as const) {
      expect(schema.safeParse(body(EIGHT)).success).toBe(true);
      const refused = schema.safeParse(body(SEVEN));
      expect(refused.success).toBe(false);
      expect(JSON.stringify(refused.error?.issues)).toContain("at least 8 characters");
      expect(schema.safeParse(body("")).success).toBe(false);
    }
  });
});

describe("a member setting a password", () => {
  it("with a setup or reset link: 7 characters refused and the link kept, 8 accepted", async () => {
    const { token } = await createSetupToken(member.id, staff.admin.id);
    const refused = await appError(() => completeSetup(token, SEVEN));
    expect(refused.status).toBe(422);
    expect(refused.fields?.password).toContain("8");
    expect((await appError(() => login(member.email, SEVEN))).status).toBe(401);

    await completeSetup(token, EIGHT);
    expect((await login(member.email, EIGHT)).user.role).toBe("member");
    expect((await login(member.memberNo, EIGHT)).user.role).toBe("member");

    // A reset link follows the same rule.
    const reset = await createSetupToken(member.id, staff.admin.id);
    expect((await appError(() => completeSetup(reset.token, "1234567"))).status).toBe(422);
    await completeSetup(reset.token, "87654321");
    expect((await login(member.email, "87654321")).user.role).toBe("member");
  });

  it("changing their own password: 7 characters refused, 8 accepted, and the other password rules still apply", async () => {
    await completeSetup((await createSetupToken(member.id, staff.admin.id)).token, "the first password");
    const refused = await appError(() => changeMemberPassword(member.id, "the first password", SEVEN, null));
    expect(refused.status).toBe(422);
    expect(refused.fields?.newPassword).toContain("8");
    expect((await login(member.email, "the first password")).user.role).toBe("member");

    // Still needs the current password, and still cannot be the member's own identifier.
    expect((await appError(() => changeMemberPassword(member.id, "not the current one", EIGHT, null))).status).toBe(422);
    expect((await appError(() => changeMemberPassword(member.id, "the first password", member.email, null))).status).toBe(422);

    await changeMemberPassword(member.id, "the first password", EIGHT, null);
    expect((await login(member.email, EIGHT)).user.role).toBe("member");
    expect((await appError(() => login(member.email, "the first password"))).status).toBe(401);
  });
});

describe("a committee account setting a password", () => {
  it("with an invitation link: 7 characters refused and the link kept, 8 accepted", async () => {
    const { setupLink } = await inviteCommitteeAccount(accountCreateSchema.parse({ role: "treasurer", name: "Tara Treasurer", email: "tara@campus.example" }), staff.admin);
    const token = setupLink.path.split("/").pop()!;
    const refused = await appError(() => completeStaffSetup(token, SEVEN));
    expect(refused.status).toBe(422);
    expect(refused.fields?.password).toContain("8");
    expect((await appError(() => login("tara@campus.example", SEVEN))).status).toBe(401);

    await completeStaffSetup(token, EIGHT);
    expect((await login("tara@campus.example", EIGHT)).user.role).toBe("treasurer");
  });

  it("with a reset link: 7 characters refused and the old password kept, 8 accepted", async () => {
    const link = await issueCommitteeSetupLink(staff.organizer.id, staff.admin);
    const token = link.path.split("/").pop()!;
    expect((await appError(() => completeStaffSetup(token, SEVEN))).status).toBe(422);
    expect((await login("organizer@test.example", "password-1")).user.role).toBe("organizer");

    await completeStaffSetup(token, EIGHT);
    expect((await login("organizer@test.example", EIGHT)).user.role).toBe("organizer");
    expect((await appError(() => login("organizer@test.example", "password-1"))).status).toBe(401);
  });

  it("from the command line: the first president, a president's reset and a committee account all take 8 and refuse 7", async () => {
    const admin = (n: number, password: string) =>
      createFirstAdmin({ email: `president${n}@club.example`, name: "New President", password }, { allowAdditional: true });
    expect((await appError(() => admin(1, SEVEN))).code).toBe("weak_password");
    expect((await admin(1, EIGHT)).role).toBe("admin");
    expect((await login("president1@club.example", EIGHT)).user.role).toBe("admin");

    expect((await appError(() => resetAdminPassword("admin@test.example", SEVEN))).code).toBe("weak_password");
    expect((await login("admin@test.example", "password-1")).user.role).toBe("admin");
    await resetAdminPassword("admin@test.example", EIGHT);
    expect((await login("admin@test.example", EIGHT)).user.role).toBe("admin");

    const committee = (password: string) => createCommitteeAccount({ email: "new.treasurer@club.example", name: "New Treasurer", role: "treasurer", password });
    expect((await appError(() => committee(SEVEN))).code).toBe("weak_password");
    expect((await committee(EIGHT)).role).toBe("treasurer");

    expect((await appError(() => createUser({ email: "x@club.example", name: "X", role: "organizer", password: SEVEN }))).code).toBe("weak_password");
  });
});

describe("passwords that already exist", () => {
  it("of any length keep signing in, and nothing rewrites them", async () => {
    // Accounts as they might exist from before: one shorter than today's minimum, one long.
    await run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword("abc"), staff.treasurer.id);
    await run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword("a much older and much longer password, 2019"), staff.organizer.id);
    await completeSetup((await createSetupToken(member.id, staff.admin.id)).token, "the first password");
    await run("UPDATE member_accounts SET password_hash = ? WHERE member_id = ?", hashPassword("12345"), member.id);
    const before = await hashes();

    expect((await login("treasurer@test.example", "abc")).user.role).toBe("treasurer");
    expect((await login("organizer@test.example", "a much older and much longer password, 2019")).user.role).toBe("organizer");
    expect((await login("admin@test.example", "password-1")).user.role).toBe("admin");
    expect((await login(member.email, "12345")).user.role).toBe("member");
    expect((await login(member.memberNo, "12345")).user.role).toBe("member");
    // Signing in still needs the right password.
    expect((await appError(() => login("treasurer@test.example", "abd"))).status).toBe(401);

    // Signing in changed no stored password, and nobody was made to choose a new one.
    expect(await hashes()).toEqual(before);
  });

  it("are untouched when someone else sets a password under the new rule", async () => {
    await completeSetup((await createSetupToken(member.id, staff.admin.id)).token, "the first password");
    const other = await createMember(memberInputSchema.parse({ name: "Noor Member", email: "noor@campus.example", duesPaid: true }), staff.admin);
    const before = await hashes();

    await completeSetup((await createSetupToken(other.id, staff.admin.id)).token, EIGHT);
    await completeStaffSetup((await issueCommitteeSetupLink(staff.organizer.id, staff.admin)).path.split("/").pop()!, EIGHT);

    const after = await hashes();
    const unchanged = (rows: { password_hash: string }[], key: (r: never) => string, skip: string) =>
      Object.fromEntries(rows.filter((r) => key(r as never) !== skip).map((r) => [key(r as never), r.password_hash]));
    expect(unchanged(after.users, (r: { id: string }) => r.id, staff.organizer.id)).toEqual(unchanged(before.users, (r: { id: string }) => r.id, staff.organizer.id));
    expect(after.members.find((m) => m.member_id === member.id)).toEqual(before.members.find((m) => m.member_id === member.id));
    expect((await login(member.email, "the first password")).user.role).toBe("member");
  });
});
