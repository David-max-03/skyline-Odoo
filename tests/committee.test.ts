import { beforeEach, describe, expect, it } from "vitest";
import {
  CAN,
  ROLES,
  accountCreateSchema,
  accountRoleSchema,
  memberInputSchema,
  orderInputSchema,
  productInputSchema,
  staffPasswordSetupSchema,
  type CommitteeSetupLink,
  type Member,
  type Role,
  type SessionUser,
} from "@/lib/contracts";
import {
  completeStaffSetup,
  inspectStaffSetupToken,
  inviteCommitteeAccount,
  issueCommitteeSetupLink,
  listCommitteeAccounts,
  setCommitteeAccountRole,
  setCommitteeAccountStatus,
} from "@/server/admin-setup";
import { completeSetup, createSetupToken, createUser, getSessionUser, login } from "@/server/auth";
import { all, get, setClock } from "@/server/db";
import { viewFinanceSummary, viewMembers } from "@/server/services/staff-views";
import { createMember, getMember } from "@/server/services/members";
import { createProduct, placeOrder } from "@/server/services/merch";
import { registerForEvent } from "@/server/services/tickets";
import { appError, freshDb, publishedEvent, type Staff } from "./helpers";

/**
 * Committee management from the web: the president adds accounts, promotes
 * members, changes roles and removes access. Every check calls the service a
 * route calls, with a session user, so it holds whatever the page shows.
 */

let staff: Staff;
let member: Member;

const PASSWORD = "four unrelated words";
const tokenOf = (link: CommitteeSetupLink) => link.path.split("/").pop()!;
const asMember = (m: Member): SessionUser => ({ id: m.id, name: m.name, email: m.email, role: "member", memberId: m.id, memberNo: m.memberNo });
const invite = (input: unknown, actor: SessionUser | null = staff.admin) => inviteCommitteeAccount(accountCreateSchema.parse(input), actor);
const count = async (table: string) => (await get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
const activePresidents = async () =>
  (await get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND password_hash <> 'unset'"))!.n;

/** Everything a member owns, row for row. */
const memberRecords = async () => ({
  members: await all("SELECT * FROM members ORDER BY id"),
  periods: await all("SELECT * FROM membership_periods ORDER BY id"),
  accounts: await all("SELECT * FROM member_accounts ORDER BY member_id"),
  tickets: await all("SELECT * FROM tickets ORDER BY id"),
  orders: await all("SELECT * FROM orders ORDER BY id"),
  transactions: await all("SELECT * FROM transactions ORDER BY id"),
});

beforeEach(async () => {
  staff = await freshDb();
  member = await createMember(memberInputSchema.parse({ name: "Mira Member", email: "mira@campus.example", duesPaid: true }), staff.treasurer);
});

describe("adding a committee account", () => {
  it("is done by the president, for every role, without any password being chosen or shown", async () => {
    for (const role of ROLES) {
      const created = await invite({ role, name: `New ${role}`, email: `new.${role}@campus.example` });
      expect(created.account).toMatchObject({ role, email: `new.${role}@campus.example`, setupPending: true, disabledAt: null, memberNo: null });
      expect(created.setupLink.path).toMatch(/^\/committee-setup\/[\w-]{40,}$/);
      expect(JSON.stringify(created)).not.toMatch(/password|hash/i);
    }
    expect(await count("users")).toBe(6);
    // Only the SHA-256 of a link is stored.
    const stored = await all<{ token_hash: string }>("SELECT token_hash FROM staff_setup_tokens");
    expect(stored).toHaveLength(3);
    expect(stored.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash))).toBe(true);
  });

  it("is refused to the treasurer, the event handler, a member and nobody at all", async () => {
    const input = { role: "treasurer", name: "Someone Else", email: "someone@campus.example" };
    expect((await appError(() => invite(input, staff.treasurer))).status).toBe(403);
    expect((await appError(() => invite(input, staff.organizer))).status).toBe(403);
    expect((await appError(() => invite(input, asMember(member)))).status).toBe(403);
    expect((await appError(() => invite(input, null))).status).toBe(401);
    // Not even to make themselves or a friend president.
    expect((await appError(() => invite({ ...input, role: "admin" }, staff.treasurer))).status).toBe(403);
    expect(await count("users")).toBe(3);
    expect(await count("staff_setup_tokens")).toBe(0);
  });

  it("cannot sign in until the person sets a password with the link, which then works once", async () => {
    const { setupLink } = await invite({ role: "treasurer", name: "Tara Treasurer", email: "tara@campus.example" });
    for (const guess of ["", "unset", PASSWORD]) {
      expect((await appError(() => login("tara@campus.example", guess))).status).toBe(401);
    }
    expect(await inspectStaffSetupToken(tokenOf(setupLink))).toMatchObject({ name: "Tara Treasurer", email: "tara@campus.example", role: "treasurer" });

    // A weak password is refused and leaves the link usable.
    expect((await appError(() => completeStaffSetup(tokenOf(setupLink), "short"))).status).toBe(422);
    expect((await appError(() => completeStaffSetup(tokenOf(setupLink), "tara@campus.example"))).status).toBe(422);
    expect(staffPasswordSetupSchema.safeParse({ token: tokenOf(setupLink), password: "short" }).success).toBe(false);

    expect(await completeStaffSetup(tokenOf(setupLink), PASSWORD)).toEqual({ email: "tara@campus.example" });
    expect((await login("tara@campus.example", PASSWORD)).user.role).toBe("treasurer");
    expect((await appError(() => completeStaffSetup(tokenOf(setupLink), "another long password"))).code).toBe("invalid_link");
    expect((await appError(() => inspectStaffSetupToken(tokenOf(setupLink)))).code).toBe("invalid_link");
    expect((await listCommitteeAccounts(staff.admin)).find((a) => a.email === "tara@campus.example")!.setupPending).toBe(false);
  });

  it("refuses an expired link, a made-up link, and an earlier link once a new one is issued", async () => {
    const created = await invite({ role: "organizer", name: "Omar Organizer", email: "omar@campus.example" });
    expect((await appError(() => completeStaffSetup("x".repeat(43), PASSWORD))).code).toBe("invalid_link");

    const second = await issueCommitteeSetupLink(created.account.id, staff.admin);
    expect((await appError(() => completeStaffSetup(tokenOf(created.setupLink), PASSWORD))).code).toBe("invalid_link");

    setClock(() => new Date(Date.now() + 73 * 3_600_000));
    expect((await appError(() => completeStaffSetup(tokenOf(second), PASSWORD))).code).toBe("invalid_link");
    setClock(null);
    expect(await completeStaffSetup(tokenOf(second), PASSWORD)).toEqual({ email: "omar@campus.example" });
  });

  it("rejects a duplicate email, whatever its case, and creates nothing", async () => {
    for (const email of ["treasurer@test.example", "TREASURER@Test.Example"]) {
      const refused = await appError(() => invite({ role: "organizer", name: "Second Person", email }));
      expect(refused).toMatchObject({ status: 409, code: "email_taken" });
    }
    await invite({ role: "organizer", name: "Once Only", email: "once@campus.example" });
    expect((await appError(() => invite({ role: "treasurer", name: "Once Only", email: "once@campus.example" }))).code).toBe("email_taken");
    expect(await count("users")).toBe(4);
    expect((await login("treasurer@test.example", "password-1")).user.role).toBe("treasurer");
  });

  it("accepts only a role, and a name and email or a member: nothing else can be set", async () => {
    const base = { role: "treasurer", name: "Someone Else", email: "someone@campus.example" };
    for (const extra of [{ password: PASSWORD }, { passwordHash: "x" }, { id: "usr_chosen" }, { disabledAt: null }, { isYou: true }, { memberNo: "SKY-M-0001" }]) {
      expect(accountCreateSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
    for (const role of ["member", "superadmin", "", "ADMIN", null, undefined, 1]) {
      expect(accountCreateSchema.safeParse({ ...base, role }).success).toBe(false);
      expect(accountRoleSchema.safeParse({ role }).success).toBe(false);
    }
    expect(accountRoleSchema.safeParse({ role: "admin", disabledAt: null }).success).toBe(false);
    expect(accountCreateSchema.safeParse({ role: "treasurer", name: "A", email: "not-an-email" }).success).toBe(false);
    expect(accountCreateSchema.safeParse({ role: "treasurer" }).success).toBe(false);
    // The service does not rely on the schema alone.
    expect((await appError(() => inviteCommitteeAccount({ ...base, role: "member" as Role }, staff.admin))).status).toBe(422);
    expect((await appError(() => setCommitteeAccountRole(staff.treasurer.id, "owner" as Role, staff.admin))).status).toBe(422);
    expect(await count("users")).toBe(3);
  });
});

describe("promoting an existing member", () => {
  beforeEach(async () => {
    // A member with a sign-in, a ticket, an order and paid dues.
    await completeSetup((await createSetupToken(member.id, staff.admin.id)).token, "a-member-password");
    const event = await publishedEvent(staff, { title: "Winter Gala" });
    await registerForEvent(event.id, { name: member.name, email: member.email, studentId: null, memberNo: member.memberNo });
    const product = await createProduct(productInputSchema.parse({ name: "Mug", priceCents: 9000, memberPriceCents: 8000, variants: [{ size: "One", stock: 3 }] }), staff.treasurer);
    await placeOrder(orderInputSchema.parse({ productId: product.id, variantId: product.variants[0].id, quantity: 1, name: member.name, email: member.email }));
  });

  it("adds a linked committee account and leaves every member record exactly as it was", async () => {
    const before = await memberRecords();
    const detail = await getMember(member.id);
    expect(before.tickets).toHaveLength(1);
    expect(before.orders).toHaveLength(1);
    expect(before.periods).toHaveLength(1);
    expect(before.transactions.length).toBeGreaterThan(0);

    const created = await invite({ role: "organizer", memberId: member.id });
    expect(created.account).toMatchObject({ name: "Mira Member", email: "mira@campus.example", role: "organizer", memberNo: member.memberNo, setupPending: true });
    await completeStaffSetup(tokenOf(created.setupLink), PASSWORD);

    expect(await memberRecords()).toEqual(before);
    expect(await getMember(member.id)).toEqual(detail);
    expect(await count("members")).toBe(1);
    expect((await get<{ member_id: string }>("SELECT member_id FROM users WHERE id = ?", created.account.id))!.member_id).toBe(member.id);
  });

  it("gives the person two sign-ins with one email: the member password and the committee password", async () => {
    const created = await invite({ role: "organizer", memberId: member.id });
    // Before the committee password is set, the email still signs in as the member.
    expect((await login(member.email, "a-member-password")).user).toMatchObject({ role: "member", memberNo: member.memberNo });
    await completeStaffSetup(tokenOf(created.setupLink), PASSWORD);

    expect((await login(member.email, PASSWORD)).user).toMatchObject({ role: "organizer", memberId: null });
    expect((await login(member.email, "a-member-password")).user).toMatchObject({ role: "member", memberNo: member.memberNo });
    expect((await login(member.memberNo, "a-member-password")).user.role).toBe("member");
    // The member password never opens the committee area.
    expect((await appError(() => login(member.memberNo, PASSWORD))).status).toBe(401);
  });

  it("takes the name and email from the member record, not from the request", async () => {
    const created = await invite({ role: "treasurer", memberId: member.id, name: "Someone Else", email: "attacker@elsewhere.example" });
    expect(created.account).toMatchObject({ name: "Mira Member", email: "mira@campus.example" });
    expect(await get("SELECT 1 FROM users WHERE email = ?", "attacker@elsewhere.example")).toBeUndefined();
  });

  it("refuses a second account for the same member, an unknown member, and a new account on a member's email", async () => {
    await invite({ role: "organizer", memberId: member.id });
    expect((await appError(() => invite({ role: "treasurer", memberId: member.id }))).code).toBe("already_committee");
    expect((await appError(() => invite({ role: "treasurer", memberId: "mem_missing" }))).status).toBe(404);

    const other = await createMember(memberInputSchema.parse({ name: "Noor Member", email: "noor@campus.example" }), staff.treasurer);
    const refused = await appError(() => invite({ role: "treasurer", name: "Noor Member", email: "NOOR@campus.example" }));
    expect(refused).toMatchObject({ status: 409, code: "member_email" });
    expect(refused.message).toContain(other.memberNo);
    expect(await count("users")).toBe(4);
    expect(await count("members")).toBe(2);
  });

  it("is refused to everyone but the president", async () => {
    for (const actor of [staff.treasurer, staff.organizer, asMember(member)]) {
      expect((await appError(() => invite({ role: "organizer", memberId: member.id }, actor))).status).toBe(403);
    }
    // A member cannot promote themselves.
    expect((await appError(() => invite({ role: "admin", memberId: member.id }, asMember(member)))).status).toBe(403);
    expect(await count("users")).toBe(3);
  });

  it("removing committee access later does not touch the membership", async () => {
    const created = await invite({ role: "organizer", memberId: member.id });
    await completeStaffSetup(tokenOf(created.setupLink), PASSWORD);
    const before = await memberRecords();
    await setCommitteeAccountStatus(created.account.id, "disable", staff.admin);

    expect(await memberRecords()).toEqual(before);
    expect((await appError(() => login(member.email, PASSWORD))).status).toBe(401);
    expect((await login(member.email, "a-member-password")).user.role).toBe("member");
  });
});

describe("changing a role", () => {
  it("is done by the president and signs the account out, so the new role applies at once", async () => {
    const session = await login("organizer@test.example", "password-1");
    expect((await getSessionUser(session.token))!.role).toBe("organizer");

    const updated = await setCommitteeAccountRole(staff.organizer.id, "treasurer", staff.admin);
    expect(updated).toMatchObject({ id: staff.organizer.id, role: "treasurer" });
    expect(await getSessionUser(session.token)).toBeNull();
    expect((await get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", staff.organizer.id))!.n).toBe(0);

    const again = await login("organizer@test.example", "password-1");
    expect(again.user.role).toBe("treasurer");
    // The new role's permissions hold, and the old role's are gone.
    expect((await viewFinanceSummary(again.user)).incomeSettledCents).toBeGreaterThanOrEqual(0);
    await setCommitteeAccountRole(staff.organizer.id, "organizer", staff.admin);
    expect((await appError(async () => viewMembers((await getSessionUser((await login("organizer@test.example", "password-1")).token))!))).status).toBe(403);
  });

  it("is refused to every other role, including for their own account", async () => {
    for (const actor of [staff.treasurer, staff.organizer, asMember(member)]) {
      expect((await appError(() => setCommitteeAccountRole(actor.id, "admin", actor))).status).toBe(403);
      expect((await appError(() => setCommitteeAccountRole(staff.organizer.id, "treasurer", actor))).status).toBe(403);
      expect((await appError(() => setCommitteeAccountRole(staff.admin.id, "organizer", actor))).status).toBe(403);
    }
    expect((await appError(() => setCommitteeAccountRole(staff.organizer.id, "admin", null))).status).toBe(401);
    expect((await all<{ role: string }>("SELECT role FROM users ORDER BY role")).map((r) => r.role)).toEqual(["admin", "organizer", "treasurer"]);
  });

  it("rejects the same role, an unknown account and an account that is not a committee account", async () => {
    expect((await appError(() => setCommitteeAccountRole(staff.treasurer.id, "treasurer", staff.admin))).code).toBe("same_role");
    expect((await appError(() => setCommitteeAccountRole("usr_missing", "treasurer", staff.admin))).status).toBe(404);
    expect((await appError(() => setCommitteeAccountRole(member.id, "admin", staff.admin))).status).toBe(404);
  });

  it("a president made president by another can then act, and one demoted cannot", async () => {
    await setCommitteeAccountRole(staff.treasurer.id, "admin", staff.admin);
    const promoted = (await login("treasurer@test.example", "password-1")).user;
    expect((await listCommitteeAccounts(promoted)).length).toBe(3);

    await setCommitteeAccountRole(staff.treasurer.id, "treasurer", staff.admin);
    // Even holding a session object that still says "admin", the demoted account is refused.
    expect((await appError(() => setCommitteeAccountRole(staff.organizer.id, "admin", promoted))).status).toBe(403);
    expect((await appError(() => invite({ role: "admin", name: "Back Door", email: "back@door.example" }, promoted))).status).toBe(403);
  });
});

describe("there is always an active president", () => {
  it("the only president cannot demote, disable or re-link their own account", async () => {
    expect((await appError(() => setCommitteeAccountRole(staff.admin.id, "treasurer", staff.admin))).code).toBe("own_account");
    expect((await appError(() => setCommitteeAccountStatus(staff.admin.id, "disable", staff.admin))).code).toBe("own_account");
    expect((await appError(() => issueCommitteeSetupLink(staff.admin.id, staff.admin))).code).toBe("own_account");
    expect(await activePresidents()).toBe(1);
    expect((await login("admin@test.example", "password-1")).user.role).toBe("admin");
  });

  it("an invited president who has not set a password does not count and cannot be relied on", async () => {
    const invited = await invite({ role: "admin", name: "Second President", email: "second@campus.example" });
    expect(await activePresidents()).toBe(1);
    // The first president still cannot remove themselves, so the committee is never left with only the invitation.
    expect((await appError(() => setCommitteeAccountStatus(staff.admin.id, "disable", staff.admin))).code).toBe("own_account");
    await completeStaffSetup(tokenOf(invited.setupLink), PASSWORD);
    expect(await activePresidents()).toBe(2);
  });

  it("two presidents demoting each other at the same moment leave exactly one", async () => {
    const second = await createUser({ email: "second@test.example", name: "Second", role: "admin", password: "password-1" });
    const results = await Promise.allSettled([
      setCommitteeAccountRole(second.id, "organizer", staff.admin),
      setCommitteeAccountRole(staff.admin.id, "organizer", second),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.status).toBe(403);
    expect(await activePresidents()).toBe(1);
  });

  it("two presidents disabling each other, or one disabling while the other demotes, leave exactly one", async () => {
    const second = await createUser({ email: "second@test.example", name: "Second", role: "admin", password: "password-1" });
    const third = await createUser({ email: "third@test.example", name: "Third", role: "admin", password: "password-1" });
    const first = await Promise.allSettled([
      setCommitteeAccountStatus(second.id, "disable", staff.admin),
      setCommitteeAccountStatus(staff.admin.id, "disable", second),
    ]);
    expect(first.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await activePresidents()).toBe(2); // one of the pair, and the third

    const survivor = first[0].status === "fulfilled" ? staff.admin : second;
    const mixed = await Promise.allSettled([
      setCommitteeAccountStatus(third.id, "disable", survivor),
      setCommitteeAccountRole(survivor.id, "treasurer", third),
    ]);
    expect(mixed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await activePresidents()).toBe(1);
  });

  it("many simultaneous attempts never leave the committee without a president", async () => {
    const others = await Promise.all(
      [1, 2, 3].map((n) => createUser({ email: `p${n}@test.example`, name: `President ${n}`, role: "admin", password: "password-1" })),
    );
    const presidents = [staff.admin, ...others];
    const attempts = presidents.flatMap((actor) =>
      presidents.filter((target) => target.id !== actor.id).flatMap((target) => [
        setCommitteeAccountStatus(target.id, "disable", actor),
        setCommitteeAccountRole(target.id, "organizer", actor),
      ]),
    );
    await Promise.allSettled(attempts);
    expect(await activePresidents()).toBe(1);
  });
});

describe("removing and restoring access", () => {
  it("disabling ends sessions, blocks sign-in and cancels an unused setup link; the row stays", async () => {
    const invited = await invite({ role: "organizer", name: "Omar Organizer", email: "omar@campus.example" });
    const session = await login("treasurer@test.example", "password-1");

    await setCommitteeAccountStatus(staff.treasurer.id, "disable", staff.admin);
    expect(await getSessionUser(session.token)).toBeNull();
    expect((await appError(() => login("treasurer@test.example", "password-1"))).status).toBe(401);
    expect((await appError(() => issueCommitteeSetupLink(staff.treasurer.id, staff.admin))).code).toBe("account_disabled");

    await setCommitteeAccountStatus(invited.account.id, "disable", staff.admin);
    expect((await appError(() => completeStaffSetup(tokenOf(invited.setupLink), PASSWORD))).code).toBe("invalid_link");
    expect(await count("users")).toBe(4);
  });

  it("restoring access brings back sign-in with the same password and role", async () => {
    await setCommitteeAccountStatus(staff.treasurer.id, "disable", staff.admin);
    const restored = await setCommitteeAccountStatus(staff.treasurer.id, "enable", staff.admin);
    expect(restored).toMatchObject({ disabledAt: null, role: "treasurer" });
    expect((await login("treasurer@test.example", "password-1")).user.role).toBe("treasurer");
  });

  it("a reset link replaces the password and signs the account out, and only the president can make one", async () => {
    for (const actor of [staff.treasurer, staff.organizer, asMember(member)]) {
      expect((await appError(() => issueCommitteeSetupLink(staff.organizer.id, actor))).status).toBe(403);
    }
    expect((await appError(() => issueCommitteeSetupLink("usr_missing", staff.admin))).status).toBe(404);
    // Allowed for a treasurer and for an event handler.
    expect((await issueCommitteeSetupLink(staff.treasurer.id, staff.admin)).role).toBe("treasurer");

    const session = await login("organizer@test.example", "password-1");
    const link = await issueCommitteeSetupLink(staff.organizer.id, staff.admin);
    // The old password keeps working until the link is used.
    expect(await getSessionUser(session.token)).not.toBeNull();
    await completeStaffSetup(tokenOf(link), PASSWORD);
    expect(await getSessionUser(session.token)).toBeNull();
    expect((await appError(() => login("organizer@test.example", "password-1"))).status).toBe(401);
    expect((await login("organizer@test.example", PASSWORD)).user.role).toBe("organizer");
  });
});

describe("password links and presidents", () => {
  it("a president cannot create a password link for another president", async () => {
    const second = await createUser({ email: "second@test.example", name: "Second", role: "admin", password: "password-1" });
    const session = await login("second@test.example", "password-1");

    for (const [actor, target] of [[staff.admin, second], [second, staff.admin]] as const) {
      const refused = await appError(() => issueCommitteeSetupLink(target.id, actor));
      expect(refused.status).toBe(403);
    }
    expect(await count("staff_setup_tokens")).toBe(0);
    // Nothing about the other president changed.
    expect(await getSessionUser(session.token)).not.toBeNull();
    expect((await login("second@test.example", "password-1")).user.role).toBe("admin");
  });

  it("the restriction follows the role: it applies once someone is made president, and lifts if they are not", async () => {
    await setCommitteeAccountRole(staff.treasurer.id, "admin", staff.admin);
    expect((await appError(() => issueCommitteeSetupLink(staff.treasurer.id, staff.admin))).status).toBe(403);
    await setCommitteeAccountRole(staff.treasurer.id, "treasurer", staff.admin);
    expect((await issueCommitteeSetupLink(staff.treasurer.id, staff.admin)).email).toBe("treasurer@test.example");
  });

  it("an invited president who has no password yet can be sent their invitation again, and not after", async () => {
    const invited = await invite({ role: "admin", name: "Second President", email: "second@campus.example" });
    const again = await issueCommitteeSetupLink(invited.account.id, staff.admin);
    expect((await appError(() => completeStaffSetup(tokenOf(invited.setupLink), PASSWORD))).code).toBe("invalid_link");
    await completeStaffSetup(tokenOf(again), PASSWORD);
    expect((await appError(() => issueCommitteeSetupLink(invited.account.id, staff.admin))).status).toBe(403);
  });
});

describe("the existing rules", () => {
  it("still keep committee accounts to the president", async () => {
    expect(CAN.manageAccounts).toEqual(["admin"]);
    for (const actor of [staff.treasurer, staff.organizer, asMember(member)]) {
      expect((await appError(() => listCommitteeAccounts(actor))).status).toBe(403);
      expect((await appError(() => setCommitteeAccountStatus(staff.organizer.id, "disable", actor))).status).toBe(403);
    }
    const listed = await listCommitteeAccounts(staff.admin);
    expect(listed.map((a) => [a.role, a.setupPending, a.memberNo, a.isYou])).toEqual([
      ["admin", false, null, true],
      ["treasurer", false, null, false],
      ["organizer", false, null, false],
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/password|hash|scrypt/i);
  });
});
