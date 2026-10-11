import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SETTINGS,
  applicationInputSchema,
  applicationReviewSchema,
  memberInputSchema,
  taskInputSchema,
  transactionInputSchema,
  type ApplicationInput,
} from "@/lib/contracts";
import {
  SETUP_LINK_HOURS,
  completeSetup,
  createSetupToken,
  getSessionUser,
  inspectSetupToken,
  login,
  logout,
} from "@/server/auth";
import { all, get, setClock, today } from "@/server/db";
import { requireMember } from "@/server/errors";
import {
  getApplicationStatus,
  listApplications,
  readEvidence,
  reviewApplication,
  submitApplication,
} from "@/server/services/applications";
import { createEvent } from "@/server/services/events";
import { createTransaction, getFinanceSummary, listTransactions } from "@/server/services/finance";
import { createMember, issueSetupLink, listMembers } from "@/server/services/members";
import { createTask } from "@/server/services/tasks";
import { checkIn } from "@/server/services/tickets";
import { MAX_IMAGE_BYTES, sniffImage, storedFileIds, uploadDir } from "@/server/storage";
import { appError, eventInput, freshDb, onPostgres, type Staff } from "./helpers";

let staff: Staff;
beforeEach(async () => {
  staff = await freshDb();
});

const PASSWORD = "correct-horse-battery";

/** The smallest byte strings that pass for each accepted image type. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1");

const application = (n: number, overrides: Record<string, unknown> = {}): ApplicationInput =>
  applicationInputSchema.parse({
    name: `Applicant ${n}`,
    email: `applicant${n}@campus.example`,
    paymentMethod: "upi",
    paymentReference: `UTR00000${n}`,
    ...overrides,
  });

const paidMember = (n: number) =>
  createMember(
    memberInputSchema.parse({ name: `Member ${n}`, email: `member${n}@campus.example`, duesPaid: true }),
    staff.admin,
  );

/** A member who has set a password, and the session a sign-in gives them. */
async function memberWithAccount(n = 1) {
  const member = await paidMember(n);
  await completeSetup((await createSetupToken(member.id, staff.admin.id)).token, PASSWORD);
  return { member, session: await login(member.memberNo, PASSWORD) };
}

const uploads = () => storedFileIds();

describe("member sign-in", () => {
  it("has no way in until a password is set through a setup link", async () => {
    const member = await paidMember(1);
    expect(member.hasAccount).toBe(false);
    expect((await appError(() => login(member.email, PASSWORD))).code).toBe("invalid_credentials");
    expect((await appError(() => login(member.memberNo, ""))).code).toBe("invalid_credentials");

    await completeSetup((await createSetupToken(member.id, staff.admin.id)).token, PASSWORD);
    expect((await listMembers())[0].hasAccount).toBe(true);
  });

  it("signs a member in by member ID or email, always with the member role", async () => {
    const { member } = await memberWithAccount();
    for (const identifier of [member.memberNo, member.memberNo.toLowerCase(), member.email, member.email.toUpperCase()]) {
      const session = await login(identifier, PASSWORD);
      expect(session.user).toMatchObject({ role: "member", memberId: member.id, memberNo: member.memberNo });
      expect(await getSessionUser(session.token)).toMatchObject({ role: "member", memberId: member.id });
    }
    expect((await appError(() => login(member.memberNo, "wrong-password-1"))).code).toBe("invalid_credentials");
    expect((await appError(() => login("SKY-M-9999", PASSWORD))).code).toBe("invalid_credentials");
  });

  it("keeps staff sign-in working and separate from member sign-in", async () => {
    const session = await login("treasurer@test.example", "password-1");
    expect(session.user).toMatchObject({ role: "treasurer", memberId: null, memberNo: null });
    expect((await getSessionUser(session.token))?.role).toBe("treasurer");

    // The same email as a member account still signs in as staff with the staff password,
    // and as a member (never as staff) with the member password.
    const member = await createMember(
      memberInputSchema.parse({ name: "Treasurer", email: "treasurer@test.example", duesPaid: true }),
      staff.admin,
    );
    await completeSetup((await createSetupToken(member.id, staff.admin.id)).token, PASSWORD);
    expect((await login("treasurer@test.example", "password-1")).user.role).toBe("treasurer");
    expect((await login("treasurer@test.example", PASSWORD)).user.role).toBe("member");
  });

  it("ends a session on sign-out and when it expires", async () => {
    const { session } = await memberWithAccount();
    expect(await getSessionUser(session.token)).not.toBeNull();
    await logout(session.token);
    expect(await getSessionUser(session.token)).toBeNull();

    const again = await login("SKY-M-0001", PASSWORD);
    setClock(() => new Date(Date.now() + 8 * 86_400_000));
    expect(await getSessionUser(again.token)).toBeNull();
    setClock(null);
  });

  it("rejects forged and cross-table tokens", async () => {
    const { session } = await memberWithAccount();
    const staffSession = await login("admin@test.example", "password-1");
    expect(await getSessionUser("m.not-a-real-token")).toBeNull();
    expect(await getSessionUser(session.token.slice(2))).toBeNull(); // member token presented as a staff token
    expect(await getSessionUser(`m.${staffSession.token}`)).toBeNull(); // staff token presented as a member token
  });
});

describe("password-setup links", () => {
  it("works once", async () => {
    const member = await paidMember(1);
    const { token } = await createSetupToken(member.id, staff.admin.id);
    expect(await inspectSetupToken(token)).toMatchObject({ memberNo: member.memberNo, name: member.name });
    expect((await completeSetup(token, PASSWORD)).memberNo).toBe(member.memberNo);
    expect((await appError(() => completeSetup(token, "another-password-1"))).code).toBe("invalid_link");
    expect((await appError(() => inspectSetupToken(token))).code).toBe("invalid_link");
    // The second attempt changed nothing.
    expect((await login(member.memberNo, PASSWORD)).user.memberId).toBe(member.id);
  });

  it("expires", async () => {
    const member = await paidMember(1);
    const { token, expiresAt } = await createSetupToken(member.id, staff.admin.id);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan((SETUP_LINK_HOURS - 1) * 3_600_000);
    setClock(() => new Date(Date.now() + (SETUP_LINK_HOURS + 1) * 3_600_000));
    expect((await appError(() => inspectSetupToken(token))).code).toBe("invalid_link");
    expect((await appError(() => completeSetup(token, PASSWORD))).code).toBe("invalid_link");
    setClock(null);
    expect(await get("SELECT 1 FROM member_accounts")).toBeUndefined();
  });

  it("is revoked when a newer link is issued", async () => {
    const member = await paidMember(1);
    const first = (await createSetupToken(member.id, staff.admin.id)).token;
    const second = (await createSetupToken(member.id, staff.admin.id)).token;
    expect((await appError(() => completeSetup(first, PASSWORD))).code).toBe("invalid_link");
    expect((await completeSetup(second, PASSWORD)).memberNo).toBe(member.memberNo);
  });

  it("stores only a hash of the link", async () => {
    const member = await paidMember(1);
    const { token } = await createSetupToken(member.id, staff.admin.id);
    const stored = await all<{ token_hash: string }>("SELECT token_hash FROM account_setup_tokens");
    expect(stored).toHaveLength(1);
    expect(stored[0].token_hash).not.toContain(token);
    expect(stored[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await appError(() => inspectSetupToken(stored[0].token_hash))).code).toBe("invalid_link");
  });

  it("refuses a weak password without spending the link", async () => {
    const member = await paidMember(1);
    const { token } = await createSetupToken(member.id, staff.admin.id);
    expect((await appError(() => completeSetup(token, "short"))).fields?.password).toBeTruthy();
    expect((await appError(() => completeSetup(token, member.email))).fields?.password).toBeTruthy();
    expect(await get("SELECT 1 FROM member_accounts")).toBeUndefined();
    expect((await completeSetup(token, PASSWORD)).memberNo).toBe(member.memberNo);
  });

  it("can only be issued by an admin or treasurer, and a reset signs old sessions out", async () => {
    const { member, session } = await memberWithAccount();
    expect((await appError(() => issueSetupLink(member.id, staff.organizer))).status).toBe(403);
    expect((await appError(() => issueSetupLink(member.id, session.user))).status).toBe(403);
    expect((await appError(() => issueSetupLink(member.id, null))).status).toBe(401);
    expect((await appError(() => issueSetupLink("mem_missing", staff.admin))).status).toBe(404);

    const link = await issueSetupLink(member.id, staff.treasurer);
    expect(link.path).toMatch(/^\/activate\/[A-Za-z0-9_-]{40,}$/);
    await completeSetup(link.path.replace("/activate/", ""), "a-brand-new-password");
    expect(await getSessionUser(session.token)).toBeNull();
    expect((await appError(() => login(member.memberNo, PASSWORD))).code).toBe("invalid_credentials");
    expect((await login(member.memberNo, "a-brand-new-password")).user.role).toBe("member");
  });
});

describe("what a member account may not do", () => {
  it("is refused by every staff operation", async () => {
    const { session } = await memberWithAccount();
    const me = session.user;
    const event = await createEvent(eventInput(), staff.organizer);

    expect((await appError(() => createEvent(eventInput(), me))).status).toBe(403);
    expect((await appError(() => createTask(taskInputSchema.parse({ title: "Assign someone" }), me))).status).toBe(403);
    expect(
      (await appError(() =>
        createTransaction(
          transactionInputSchema.parse({ type: "income", category: "donation", amountCents: 100, occurredOn: today(), description: "Self-credit" }),
          me,
        ),
      )).status,
    ).toBe(403);
    expect((await appError(() => checkIn({ code: "SKY-22222-22222", eventId: event.id, collectPayment: false, method: "cash" }, me))).status).toBe(403);
    expect((await appError(() => createMember(memberInputSchema.parse({ name: "Friend", email: "friend@campus.example" }), me))).status).toBe(403);
    expect((await appError(() => listApplications(me))).status).toBe(403);
  });

  it("tells member actions apart from staff ones", async () => {
    const { member, session } = await memberWithAccount();
    expect(requireMember(session.user)).toBe(member.id);
    expect((await appError(() => requireMember(staff.admin))).status).toBe(403);
    expect((await appError(() => requireMember(null))).status).toBe(401);
  });
});

describe("membership applications", () => {
  it("creates nothing but a pending application", async () => {
    const receipt = await submitApplication(application(1), PNG);
    expect(receipt).toMatchObject({ status: "pending", amountCents: SETTINGS.membershipFeeCents });
    expect(receipt.code).toMatch(/^APP-[2-9A-Z]{6}$/);

    // No member, no member ID, no money in the books, no account.
    expect(await listMembers()).toHaveLength(0);
    expect(await listTransactions()).toHaveLength(0);
    expect(await get("SELECT 1 FROM member_accounts")).toBeUndefined();
    expect(await get("SELECT 1 FROM account_setup_tokens")).toBeUndefined();
    expect(await getApplicationStatus(receipt.code, "applicant1@campus.example")).toMatchObject({ status: "pending", memberNo: null });
  });

  it("requires a screenshot for UPI and bank payments, and only accepts real images", async () => {
    expect((await appError(() => submitApplication(application(1), null))).fields?.evidence).toBeTruthy();
    expect((await appError(() => submitApplication(application(1, { paymentMethod: "bank" }), null))).fields?.evidence).toBeTruthy();
    expect((await appError(() => submitApplication(application(1), Buffer.from("<svg onload=alert(1)>")))).fields?.evidence).toBeTruthy();
    expect((await appError(() => submitApplication(application(1), Buffer.from("%PDF-1.7 not an image")))).fields?.evidence).toBeTruthy();
    expect((await appError(() => submitApplication(application(1), Buffer.alloc(MAX_IMAGE_BYTES + 1, 0xff)))).fields?.evidence).toBeTruthy();
    expect(await all("SELECT 1 FROM membership_applications")).toHaveLength(0);
    expect(await uploads()).toHaveLength(0);

    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(Buffer.from("GIF89a"))).toBeNull();

    await submitApplication(application(1), JPEG);
    await submitApplication(application(2, { paymentMethod: "cash", paymentReference: "Paid the treasurer" }), null);
    expect(await uploads()).toHaveLength(1);
  });

  it("refuses duplicates: an existing member, an open application, a reused reference", async () => {
    await paidMember(1);
    expect((await appError(() => submitApplication(application(1, { email: "MEMBER1@campus.example" }), PNG))).code).toBe("already_member");

    await submitApplication(application(2), PNG);
    expect((await appError(() => submitApplication(application(2, { paymentReference: "UTR-OTHER" }), PNG))).code).toBe("application_pending");
    // Same reference, written with spaces and in lower case, from someone else.
    expect((await appError(() => submitApplication(application(3, { paymentReference: "utr 000 002" }), PNG))).code).toBe("reference_used");

    // A refused application leaves no file behind.
    expect(await uploads()).toHaveLength(1);
  });

  it("makes someone a member only when a reviewer confirms the money arrived", async () => {
    await submitApplication(application(1), PNG);
    const [pending] = await listApplications(staff.treasurer);

    // The request schema will not accept an approval without the confirmation.
    expect(applicationReviewSchema.safeParse({ action: "approve" }).success).toBe(false);
    expect(applicationReviewSchema.safeParse({ action: "approve", paymentReceived: false }).success).toBe(false);
    // Nor will the service, if something calls it directly.
    expect(
      (await appError(() => reviewApplication(pending.id, { action: "approve", paymentReceived: false as unknown as true }, staff.treasurer))).status,
    ).toBe(422);
    expect(await listMembers()).toHaveLength(0);

    const { application: approved, setup } = await reviewApplication(pending.id, { action: "approve", paymentReceived: true }, staff.treasurer);
    expect(approved).toMatchObject({ status: "approved", memberNo: "SKY-M-0001", reviewedByName: "Treasurer" });

    const [member] = await listMembers();
    expect(member).toMatchObject({ memberNo: "SKY-M-0001", email: "applicant1@campus.example", status: "active", duesOwedCents: 0, hasAccount: false });

    // The dues are in the one ledger, settled, with the verified reference.
    const dues = await listTransactions({ category: "dues" });
    expect(dues).toHaveLength(1);
    expect(dues[0]).toMatchObject({ status: "settled", method: "upi", amountCents: SETTINGS.membershipFeeCents, source: "dues", memberId: member.id });
    expect(dues[0].description).toContain("UTR000001");
    expect((await getFinanceSummary()).incomeSettledCents).toBe(SETTINGS.membershipFeeCents);

    // The link sets the password; then the member can sign in.
    expect(setup).toMatchObject({ memberNo: "SKY-M-0001", email: "applicant1@campus.example" });
    await completeSetup(setup!.path.replace("/activate/", ""), PASSWORD);
    expect((await login("SKY-M-0001", PASSWORD)).user.role).toBe("member");
    expect(await getApplicationStatus(approved.code, approved.email)).toMatchObject({ status: "approved", memberNo: "SKY-M-0001" });
  });

  it("cannot be approved twice, or by someone without the right role", async () => {
    await submitApplication(application(1), PNG);
    const [pending] = await listApplications(staff.admin);
    const approve = { action: "approve", paymentReceived: true } as const;

    expect((await appError(() => reviewApplication(pending.id, approve, staff.organizer))).status).toBe(403);
    expect((await appError(() => reviewApplication(pending.id, approve, null))).status).toBe(401);
    expect((await appError(() => listApplications(staff.organizer))).status).toBe(403);
    expect((await appError(() => reviewApplication("app_missing", approve, staff.admin))).status).toBe(404);

    await reviewApplication(pending.id, approve, staff.admin);
    expect((await appError(() => reviewApplication(pending.id, approve, staff.admin))).code).toBe("already_reviewed");
    expect((await appError(() => reviewApplication(pending.id, { action: "reject", reason: "Changed my mind" }, staff.admin))).code).toBe("already_reviewed");
    expect(await listMembers()).toHaveLength(1);
    expect(await listTransactions({ category: "dues" })).toHaveLength(1);
  });

  it("leaves nothing behind when an application is rejected, and lets the person apply again", async () => {
    const receipt = await submitApplication(application(1), PNG);
    const [pending] = await listApplications(staff.treasurer);
    const { application: rejected, setup } = await reviewApplication(pending.id, { action: "reject", reason: "No payment with this reference in the account" }, staff.treasurer);
    expect(rejected.status).toBe("rejected");
    expect(setup).toBeNull();
    expect(await listMembers()).toHaveLength(0);
    expect(await listTransactions()).toHaveLength(0);
    expect((await getApplicationStatus(receipt.code, "applicant1@campus.example")).reviewNote).toContain("No payment");

    // The same person, with the same reference, may try again.
    expect((await submitApplication(application(1), PNG)).status).toBe("pending");
  });

  it("does not turn an approval into a second member if the email joined meanwhile", async () => {
    await submitApplication(application(1), PNG);
    const [pending] = await listApplications(staff.treasurer);
    await createMember(memberInputSchema.parse({ name: "Applicant 1", email: "applicant1@campus.example", duesPaid: true }), staff.admin);
    expect((await appError(() => reviewApplication(pending.id, { action: "approve", paymentReceived: true }, staff.treasurer))).code).toBe("email_taken");
    // The failed approval rolled back completely.
    expect((await listApplications(staff.treasurer))[0].status).toBe("pending");
    expect(await listMembers()).toHaveLength(1);
    expect(await listTransactions({ category: "dues" })).toHaveLength(1);
  });

  it("shows an application's status only to someone with both its code and its email", async () => {
    const receipt = await submitApplication(application(1), PNG);
    expect((await getApplicationStatus(receipt.code.toLowerCase(), "APPLICANT1@campus.example")).status).toBe("pending");
    expect((await appError(() => getApplicationStatus(receipt.code, "someone.else@campus.example"))).status).toBe(404);
    expect((await appError(() => getApplicationStatus("APP-222222", "applicant1@campus.example"))).status).toBe(404);
  });

  it("shows payment screenshots to reviewers only", async () => {
    await submitApplication(application(1), PNG);
    const [pending] = await listApplications(staff.treasurer);
    const fileId = pending.evidenceFileId!;
    const { session } = await memberWithAccount(5);

    expect(await readEvidence(fileId, staff.treasurer)).toMatchObject({ mime: "image/png" });
    expect((await readEvidence(fileId, staff.admin)).bytes.equals(PNG)).toBe(true);
    expect((await appError(() => readEvidence(fileId, staff.organizer))).status).toBe(403);
    expect((await appError(() => readEvidence(fileId, session.user))).status).toBe(403);
    expect((await appError(() => readEvidence(fileId, null))).status).toBe(401);
    expect((await appError(() => readEvidence("fil_doesnotexist", staff.admin))).status).toBe(404);
    expect((await appError(() => readEvidence("../skyline.db", staff.admin))).status).toBe(404);

    // Stored under a random id with no extension, readable only by the server's user.
    expect(await uploads()).toEqual([fileId]);
    if (!onPostgres) expect(fs.statSync(`${uploadDir()}/${fileId}`).mode & 0o077).toBe(0);
  });
});
