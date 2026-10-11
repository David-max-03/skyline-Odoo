import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountCreateSchema,
  checkoutInputSchema,
  memberInputSchema,
  productInputSchema,
  type Member,
  type Product,
  type SessionUser,
} from "@/lib/contracts";
import { completeStaffSetup, inviteCommitteeAccount } from "@/server/admin-setup";
import { completeSetup, createSetupToken, getSessionUser, login, signIn } from "@/server/auth";
import { all, get } from "@/server/db";
import { clientAddress } from "@/server/http";
import { SIGN_IN_ACCOUNT_LIMIT, enforceRateLimit } from "@/server/rate-limit";
import { listTransactions } from "@/server/services/finance";
import { createMember, getMember } from "@/server/services/members";
import { actOnOrder, checkout, checkoutAsMember, createProduct, listMemberOrders, listOrders, memberOrder } from "@/server/services/merch";
import { orderPaymentAction } from "@/server/services/order-payments";
import { clearFakeRazorpay, useFakeRazorpay } from "./fake-razorpay";
import { appError, freshDb, type Staff } from "./helpers";

/** Regression tests for three findings of the final security review. */

let staff: Staff;
let member: Member;
let product: Product;

const PASSWORD = "four unrelated words";
const item = () => [{ variantId: product.variants[0].id, quantity: 1 }];
const request = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

beforeEach(async () => {
  staff = await freshDb();
  useFakeRazorpay();
  member = await createMember(memberInputSchema.parse({ name: "Mira Member", email: "mira@campus.example", duesPaid: true }), staff.admin);
  product = await createProduct(
    productInputSchema.parse({ name: "Hoodie", priceCents: 120000, memberPriceCents: 100000, variants: [{ size: "M", stock: 20 }] }),
    staff.treasurer,
  );
});

afterEach(clearFakeRazorpay);

describe("the visitor's address used for rate limiting", () => {
  it("comes from Netlify's own header, never from the start of X-Forwarded-For", () => {
    expect(clientAddress(request({ "x-nf-client-connection-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe("203.0.113.7");
    // Rotating the first forwarded value, which the client controls, changes nothing.
    for (const forged of ["9.9.9.9", "8.8.8.8", "127.0.0.1"]) {
      expect(clientAddress(request({ "x-nf-client-connection-ip": "203.0.113.7", "x-forwarded-for": `${forged}, 203.0.113.7` }))).toBe("203.0.113.7");
    }
  });

  it("without that header takes the entry the nearest proxy wrote, not the one the client wrote", () => {
    expect(clientAddress(request({ "x-forwarded-for": "9.9.9.9, 10.0.0.1, 198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientAddress(request({ "x-forwarded-for": " 198.51.100.4 " }))).toBe("198.51.100.4");
    expect(clientAddress(request({ "x-forwarded-for": "" }))).toBeNull();
    expect(clientAddress(request({}))).toBeNull();
  });
});

describe("the sign-in limit for one account", () => {
  const attempt = (identifier: string, password = "a wrong password") => appError(() => signIn(identifier, password));

  it("stops guessing one account's password after ten attempts, from any address", async () => {
    for (let i = 0; i < SIGN_IN_ACCOUNT_LIMIT.max; i++) {
      expect((await attempt("treasurer@test.example")).status).toBe(401);
    }
    const limited = await attempt("treasurer@test.example");
    expect(limited).toMatchObject({ status: 429, code: "rate_limited" });
    expect(limited.message).toContain("15 minutes");
    // The right password is refused too while the limit holds, so nothing is learned by trying it.
    expect((await attempt("TREASURER@test.example ", "password-1")).status).toBe(429);
    // The limit never looked at an address, so there is none to rotate.
  });

  it("answers the same for an email that is not an account, so it reveals nothing", async () => {
    const real: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < SIGN_IN_ACCOUNT_LIMIT.max + 2; i++) {
      real.push((await attempt("organizer@test.example")).status);
      unknown.push((await attempt("nobody@nowhere.example")).status);
    }
    expect(unknown).toEqual(real);
    const [a, b] = [await attempt("organizer@test.example"), await attempt("nobody@nowhere.example")];
    expect([a.code, a.message]).toEqual([b.code, b.message]);
  });

  it("is per identifier: other accounts are unaffected, and an ordinary sign-in still works", async () => {
    for (let i = 0; i < SIGN_IN_ACCOUNT_LIMIT.max + 1; i++) await attempt("treasurer@test.example");
    expect((await signIn("admin@test.example", "password-1")).user.role).toBe("admin");
    expect((await signIn("organizer@test.example", "password-1")).user.role).toBe("organizer");
  });

  it("lifts by itself and changes nothing on the account", async () => {
    const before = await all("SELECT id, password_hash, disabled_at FROM users ORDER BY id");
    for (let i = 0; i < SIGN_IN_ACCOUNT_LIMIT.max + 1; i++) await attempt("treasurer@test.example");
    expect(await all("SELECT id, password_hash, disabled_at FROM users ORDER BY id")).toEqual(before);

    // The same limiter with a window that has already ended counts from one again.
    const brief = { name: "test-window", max: 2, windowMs: 1 };
    await enforceRateLimit(brief, "account:someone");
    await enforceRateLimit(brief, "account:someone");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(enforceRateLimit(brief, "account:someone")).resolves.toBeUndefined();

    // And once this account's window is over, the password works as before.
    await get("UPDATE rate_limits SET reset_at = 0 RETURNING bucket_key");
    expect((await signIn("treasurer@test.example", "password-1")).user.role).toBe("treasurer");
  });

  it("stores only a hash of the identifier", async () => {
    await attempt("treasurer@test.example");
    const keys = (await all<{ bucket_key: string }>("SELECT bucket_key FROM rate_limits")).map((r) => r.bucket_key);
    expect(keys.some((k) => k.startsWith("login-account:"))).toBe(true);
    expect(keys.join(" ")).not.toContain("treasurer");
  });
});

describe("a committee account and its own merchandise order", () => {
  /** Makes `who` a committee account through the president's page and returns its live session user. */
  async function linked(who: Member, role: "treasurer" | "admin" = "treasurer"): Promise<SessionUser> {
    const { setupLink } = await inviteCommitteeAccount(accountCreateSchema.parse({ role, memberId: who.id }), staff.admin);
    await completeStaffSetup(setupLink.path.split("/").pop()!, PASSWORD);
    return (await getSessionUser((await login(who.email, PASSWORD)).token))!;
  }
  const lineOf = async (code: string) => (await listOrders()).find((o) => o.checkoutCode === code)!;
  const settled = async () => (await listTransactions()).filter((t) => t.category === "merchandise" && t.status === "settled");

  it("cannot be marked paid by that same account, by any method", async () => {
    const treasurer = await linked(member);
    const order = await checkoutAsMember(item(), member.id);
    const line = await lineOf(order.code);
    for (const method of ["cash", "upi", "card", "bank", "other"] as const) {
      const refused = await appError(() => actOnOrder(line.id, "pay", method, treasurer));
      expect(refused.status).toBe(403);
    }
    expect((await lineOf(order.code)).paymentStatus).toBe("pending");
    expect(await settled()).toHaveLength(0);
  });

  it("is still paid the ordinary ways: by another committee member, or online", async () => {
    const treasurer = await linked(member);
    const first = await checkoutAsMember(item(), member.id);
    expect((await actOnOrder((await lineOf(first.code)).id, "pay", "cash", staff.treasurer)).order.paymentStatus).toBe("paid");

    const second = await checkoutAsMember(item(), member.id);
    const state = await orderPaymentAction(member.id, second.code, { action: "start" });
    expect(state.checkout?.amountCents).toBe(second.unpaidCents);
    // Handing over is not taking money: the same account may still record it once paid.
    expect((await actOnOrder((await lineOf(first.code)).id, "fulfil", "cash", treasurer)).order.status).toBe("fulfilled");
  });

  it("covers an order placed while the membership was not active, and a guest order under the account's own email", async () => {
    const unpaid = await createMember(memberInputSchema.parse({ name: "Uma Unpaid", email: "uma@campus.example", duesPaid: false }), staff.admin);
    const treasurer = await linked(unpaid);
    const inactive = await checkoutAsMember(item(), unpaid.id);
    expect(inactive.isMember).toBe(false);
    expect((await appError(async () => actOnOrder((await lineOf(inactive.code)).id, "pay", "cash", treasurer))).status).toBe(403);

    // An unlinked treasurer ordering as a guest with their own committee email.
    const guest = await checkout(checkoutInputSchema.parse({ items: item(), name: "Treasurer", email: "TREASURER@test.example", memberNo: null }));
    expect((await appError(async () => actOnOrder((await lineOf(guest.code)).id, "pay", "cash", staff.treasurer))).status).toBe(403);
    expect((await actOnOrder((await lineOf(guest.code)).id, "pay", "cash", staff.admin)).order.paymentStatus).toBe("paid");
  });

  it("leaves the treasurer's work on everyone else's orders as it was", async () => {
    const treasurer = await linked(member);
    const other = await createMember(memberInputSchema.parse({ name: "Noor Member", email: "noor@campus.example", duesPaid: true }), staff.admin);
    const theirs = await checkoutAsMember(item(), other.id);
    const guest = await checkout(checkoutInputSchema.parse({ items: item(), name: "Gita Guest", email: "gita@elsewhere.example", memberNo: null }));
    for (const code of [theirs.code, guest.code]) {
      const line = await lineOf(code);
      expect((await actOnOrder(line.id, "pay", "cash", treasurer)).order.paymentStatus).toBe("paid");
      expect((await actOnOrder(line.id, "fulfil", "cash", treasurer)).order.status).toBe("fulfilled");
    }
    expect(await settled()).toHaveLength(2);
  });

  it("applies to a president too", async () => {
    const president = await linked(member, "admin");
    const order = await checkoutAsMember(item(), member.id);
    expect((await appError(async () => actOnOrder((await lineOf(order.code)).id, "pay", "cash", president))).status).toBe(403);
  });
});

describe("whose order it is", () => {
  const guestWith = (email: string, name = "Stranger") =>
    checkout(checkoutInputSchema.parse({ items: item(), name, email, memberNo: null }));

  it("a guest who types a member's email gets an ordinary guest order, and it is not put in the member's list", async () => {
    const mine = await checkoutAsMember(item(), member.id);
    const typed = await guestWith("MIRA@campus.example");

    // The guest gets the standard price, no member badge, no online payment, and only their own order back.
    expect(typed).toMatchObject({ totalCents: 120000, isMember: false, payOnline: false, buyerName: "Stranger" });
    expect(JSON.stringify(typed)).not.toContain(mine.code);
    expect(JSON.stringify(typed)).not.toContain(member.memberNo);

    expect((await listMemberOrders(member.id)).map((o) => o.code)).toEqual([mine.code]);
    expect((await getMember(member.id)).orders).toHaveLength(1);
  });

  it("the member cannot open or pay the stranger's order, and the stranger's order cannot reach the member's payments", async () => {
    const typed = await guestWith(member.email);
    expect((await appError(() => memberOrder(member.id, typed.code))).status).toBe(404);
    expect((await appError(() => orderPaymentAction(member.id, typed.code, { action: "start" }))).status).toBe(404);
    expect((await appError(() => orderPaymentAction(member.id, typed.code, { action: "check" }))).status).toBe(404);
    expect(await all("SELECT id FROM order_payments")).toEqual([]);
  });

  it("an order placed from the member's own account is theirs even when the membership is not active", async () => {
    const unpaid = await createMember(memberInputSchema.parse({ name: "Uma Unpaid", email: "uma@campus.example", duesPaid: false }), staff.admin);
    const order = await checkoutAsMember(item(), unpaid.id);
    expect(order).toMatchObject({ totalCents: 120000, isMember: false, payOnline: true });
    expect((await listMemberOrders(unpaid.id)).map((o) => o.code)).toEqual([order.code]);
    expect((await orderPaymentAction(unpaid.id, order.code, { action: "start" })).checkout?.amountCents).toBe(120000);
    // Owned by record, without the member price having been applied to it.
    expect(await get("SELECT c.member_id AS owner, o.member_id AS priced FROM orders o JOIN checkouts c ON c.id = o.checkout_id WHERE c.code = ?", order.code)).toEqual({ owner: unpaid.id, priced: null });
    // And never anyone else's.
    expect(await listMemberOrders(member.id)).toEqual([]);
    expect((await appError(() => memberOrder(member.id, order.code))).status).toBe(404);
  });

  it("a guest who proves the membership with the member number and its email still gets the member price, in the member's list", async () => {
    const proven = await checkout(checkoutInputSchema.parse({ items: item(), name: "Mira Member", email: member.email, memberNo: member.memberNo }));
    expect(proven).toMatchObject({ totalCents: 100000, isMember: true });
    expect((await listMemberOrders(member.id)).map((o) => o.code)).toEqual([proven.code]);
    // A wrong pairing is refused outright rather than quietly attached to someone.
    expect((await appError(() => checkout(checkoutInputSchema.parse({ items: item(), name: "Someone Else", email: "someone@else.example", memberNo: member.memberNo })))).status).toBe(422);
  });

  it("a member's own sign-in still shows and pays their orders as before", async () => {
    await completeSetup((await createSetupToken(member.id, staff.admin.id)).token, "a-member-password");
    const order = await checkoutAsMember(item(), member.id);
    expect(order).toMatchObject({ totalCents: 100000, isMember: true, payOnline: true });
    expect((await memberOrder(member.id, order.code)).order.code).toBe(order.code);
  });
});
