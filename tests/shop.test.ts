import { beforeEach, describe, expect, it } from "vitest";
import { MAX_PRODUCT_IMAGES, checkoutInputSchema, memberCheckoutSchema, memberInputSchema, productInputSchema, type Product } from "@/lib/contracts";
import { addDays } from "@/lib/dates";
import { get, setClock, today } from "@/server/db";
import { readEvidence } from "@/server/services/applications";
import { getFinanceTotals, listTransactions } from "@/server/services/finance";
import { createMember } from "@/server/services/members";
import {
  actOnOrder,
  addProductImage,
  addVariant,
  checkout,
  checkoutAsMember,
  createProduct,
  getProduct,
  getPublicProduct,
  listMemberOrders,
  listOrders,
  listPublicProducts,
  readProductImage,
  removeProductImage,
  updateProduct,
} from "@/server/services/merch";
import { storedFileIds } from "@/server/storage";
import { appError, freshDb, type Staff } from "./helpers";

let staff: Staff;
beforeEach(async () => {
  staff = await freshDb();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const product = async (overrides: Record<string, unknown> = {}): Promise<Product> =>
  createProduct(
    productInputSchema.parse({
      name: "Hoodie",
      priceCents: 120000,
      memberPriceCents: 100000,
      variants: [{ size: "M", stock: 3 }, { size: "L", stock: 1 }],
      ...overrides,
    }),
    staff.treasurer,
  );

const size = (p: Product, s: string) => p.variants.find((v) => v.size === s)!.id;
const stockOf = async (p: Product, s: string) => (await getProduct(p.id)).variants.find((v) => v.size === s)!.stock;

const guest = (items: { variantId: string; quantity: number }[], n = 1, memberNo: string | null = null) =>
  checkoutInputSchema.parse({ items, name: `Shopper ${n}`, email: `shopper${n}@campus.example`, memberNo });

const member = (n: number, overrides: Record<string, unknown> = {}) =>
  createMember(
    memberInputSchema.parse({ name: `Member ${n}`, email: `member${n}@campus.example`, duesPaid: true, ...overrides }),
    staff.treasurer,
  );

describe("the catalogue", () => {
  it("shows active products with category, sizes, stock and photos", async () => {
    const hoodie = await product({ category: "apparel" });
    await product({ name: "Sticker pack", category: "stationery", priceCents: 5000, memberPriceCents: 5000, variants: [{ size: "One size", stock: 40 }] });
    await product({ name: "Old mug", active: false });

    const shop = await listPublicProducts();
    expect(shop.map((p) => [p.name, p.category])).toEqual([["Hoodie", "apparel"], ["Sticker pack", "stationery"]]);
    expect(shop[0].variants.map((v) => [v.size, v.stock, v.inStock])).toEqual([["M", 3, true], ["L", 1, true]]);
    expect((await getPublicProduct(hoodie.id)).name).toBe("Hoodie");
    // A product that is switched off looks missing to the public.
    const old = (await get<{ id: string }>("SELECT id FROM products WHERE name = 'Old mug'"))!;
    expect((await appError(() => getPublicProduct(old.id))).status).toBe(404);
    expect(productInputSchema.safeParse({ name: "X1", category: "weapons", priceCents: 1, memberPriceCents: 1, variants: [{ size: "S", stock: 1 }] }).success).toBe(false);
  });

  it("lets finance staff manage sizes and photos, and nobody else", async () => {
    const hoodie = await product();
    expect((await addVariant(hoodie.id, { size: "XL", stock: 4 }, staff.treasurer)).variants.map((v) => v.size)).toEqual(["M", "L", "XL"]);
    expect((await appError(() => addVariant(hoodie.id, { size: "xl", stock: 1 }, staff.treasurer))).fields?.size).toBeTruthy();
    expect((await appError(() => addVariant(hoodie.id, { size: "S", stock: 1 }, staff.organizer))).status).toBe(403);

    expect((await appError(() => addProductImage(hoodie.id, PNG, staff.organizer))).status).toBe(403);
    expect((await appError(() => addProductImage(hoodie.id, Buffer.from("<svg/>"), staff.treasurer))).fields?.image).toBeTruthy();
    expect((await appError(() => addProductImage(hoodie.id, null, staff.treasurer))).fields?.image).toBeTruthy();

    const withPhoto = await addProductImage(hoodie.id, PNG, staff.treasurer);
    expect(withPhoto.images).toHaveLength(1);
    const fileId = withPhoto.images[0].url.split("/").pop()!;
    expect((await readProductImage(fileId)).mime).toBe("image/png");
    expect((await getPublicProduct(hoodie.id)).images[0].url).toBe(withPhoto.images[0].url);

    for (let i = 1; i < MAX_PRODUCT_IMAGES; i++) await addProductImage(hoodie.id, PNG, staff.admin);
    expect((await appError(() => addProductImage(hoodie.id, PNG, staff.admin))).fields?.image).toBeTruthy();

    expect((await appError(() => removeProductImage(hoodie.id, withPhoto.images[0].id, staff.organizer))).status).toBe(403);
    expect((await removeProductImage(hoodie.id, withPhoto.images[0].id, staff.treasurer)).images).toHaveLength(MAX_PRODUCT_IMAGES - 1);
    expect((await appError(() => readProductImage(fileId))).status).toBe(404);
    expect(await storedFileIds()).not.toContain(fileId);
  });

  it("keeps the public photo route away from private evidence, and the reverse", async () => {
    const hoodie = await addProductImage((await product()).id, PNG, staff.treasurer);
    const fileId = hoodie.images[0].url.split("/").pop()!;
    // A product photo is not evidence, so the evidence reader does not serve it.
    expect((await appError(() => readEvidence(fileId, staff.treasurer))).status).toBe(404);
    expect((await appError(() => readProductImage("fil_notaproductphoto"))).status).toBe(404);
    expect((await appError(() => readProductImage("../skyline.db"))).status).toBe(404);
  });
});

describe("checkout", () => {
  it("prices every line on the server and ignores anything the browser sends about money", async () => {
    const hoodie = await product();
    const tee = await product({ name: "Tee", priceCents: 45000, memberPriceCents: 38000, variants: [{ size: "S", stock: 10 }] });
    const input = checkoutInputSchema.parse({
      items: [
        { variantId: size(hoodie, "M"), quantity: 2, unitPriceCents: 1, totalCents: 1 },
        { variantId: size(tee, "S"), quantity: 3, priceCents: 0 },
      ],
      name: "Shopper 1",
      email: "shopper1@campus.example",
      totalCents: 5,
      paymentStatus: "paid",
    });
    expect(JSON.stringify(input)).not.toMatch(/unitPriceCents|totalCents|paymentStatus|priceCents/);

    const order = await checkout(input);
    expect(order.code).toMatch(/^CHK-[2-9A-Z]{6}$/);
    expect(order.lines.map((l) => [l.productName, l.size, l.quantity, l.unitPriceCents, l.totalCents])).toEqual([
      ["Hoodie", "M", 2, 120000, 240000],
      ["Tee", "S", 3, 45000, 135000],
    ]);
    expect(order).toMatchObject({ totalCents: 375000, unpaidCents: 375000, isMember: false });
    expect(order.lines.every((l) => l.paymentStatus === "pending" && l.status === "placed")).toBe(true);
    expect(await stockOf(hoodie, "M")).toBe(1);
    expect(await stockOf(tee, "S")).toBe(7);

    // Owed in the ledger, one row per line, nothing collected.
    expect((await listTransactions({ category: "merchandise" })).map((t) => [t.status, t.amountCents]).sort()).toEqual([["pending", 135000], ["pending", 240000]]);
    expect(await getFinanceTotals()).toMatchObject({ incomeSettledCents: 0, incomePendingCents: 375000 });
  });

  it("rejects invalid quantities and carts", async () => {
    const hoodie = await product();
    const line = (quantity: unknown) => checkoutInputSchema.safeParse({ items: [{ variantId: size(hoodie, "M"), quantity }], name: "Shopper", email: "s@campus.example" });
    for (const bad of [0, -1, 1.5, 11, "2", null]) expect(line(bad).success, String(bad)).toBe(false);
    expect(line(1).success).toBe(true);
    expect(checkoutInputSchema.safeParse({ items: [], name: "Shopper", email: "s@campus.example" }).success).toBe(false);
    expect(memberCheckoutSchema.safeParse({ items: [] }).success).toBe(false);

    expect((await appError(() => checkout(guest([{ variantId: "var_missing", quantity: 1 }])))).fields?.variantId).toBeTruthy();
    // The same size split across lines is counted together.
    const big = await product({ name: "Pins", variants: [{ size: "One size", stock: 50 }] });
    const split = guest([{ variantId: size(big, "One size"), quantity: 6 }, { variantId: size(big, "One size"), quantity: 6 }]);
    expect((await appError(() => checkout(split))).fields?.quantity).toBeTruthy();
    expect(await stockOf(big, "One size")).toBe(50);
  });

  it("is all or nothing: one size short means no stock is taken and nothing is recorded", async () => {
    const hoodie = await product(); // M: 3, L: 1
    const error = await appError(() => checkout(guest([{ variantId: size(hoodie, "M"), quantity: 2 }, { variantId: size(hoodie, "L"), quantity: 2 }])));
    expect(error.code).toBe("out_of_stock");
    expect(error.message).toContain("Only 1 left");
    expect(await stockOf(hoodie, "M")).toBe(3);
    expect(await stockOf(hoodie, "L")).toBe(1);
    expect(await listOrders()).toHaveLength(0);
    expect(await listTransactions()).toHaveLength(0);
    expect(await get("SELECT 1 FROM checkouts")).toBeUndefined();
  });

  it("cannot oversell when many buyers want the last units", async () => {
    const hoodie = await product({ variants: [{ size: "M", stock: 3 }] });
    // All eight at once: only three can get a unit.
    const results = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        try {
          await checkout(guest([{ variantId: size(hoodie, "M"), quantity: 1 }], i));
          return "ok";
        } catch (error) {
          return (error as { code?: string }).code;
        }
      }),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(3);
    expect(results.filter((r) => r === "out_of_stock")).toHaveLength(5);
    expect(await stockOf(hoodie, "M")).toBe(0);
    expect((await listOrders()).reduce((sum, o) => sum + o.quantity, 0)).toBe(3);
    // The database refuses a negative count even if code tried.
    await expect(get("UPDATE product_variants SET stock = -1 RETURNING stock")).rejects.toThrow();
    expect((await appError(() => checkout(guest([{ variantId: size(hoodie, "M"), quantity: 1 }], 99)))).message).toContain("sold out");
  });

  it("does not sell a product that has been switched off", async () => {
    const hoodie = await product();
    await updateProduct(hoodie.id, { name: "Hoodie", category: "apparel", description: "", priceCents: 120000, memberPriceCents: 100000, active: false }, staff.treasurer);
    expect((await appError(() => checkout(guest([{ variantId: size(hoodie, "M"), quantity: 1 }])))).status).toBe(422);
    expect(await stockOf(hoodie, "M")).toBe(3);
  });

  it("gives the member price only to an active member", async () => {
    const hoodie = await product({ variants: [{ size: "M", stock: 20 }] });
    const active = await member(1);
    const unpaid = await member(2, { duesPaid: false });
    const lapsing = await member(3, { expiresOn: addDays(today(), 1) });
    const items = [{ variantId: size(hoodie, "M"), quantity: 1 }];

    expect(await checkoutAsMember(items, active.id)).toMatchObject({ totalCents: 100000, isMember: true, buyerName: "Member 1" });
    expect(await checkoutAsMember(items, unpaid.id)).toMatchObject({ totalCents: 120000, isMember: false });
    setClock(() => new Date(Date.now() + 3 * 86_400_000));
    expect(await checkoutAsMember(items, lapsing.id)).toMatchObject({ totalCents: 120000, isMember: false });
    setClock(null);

    // A visitor needs both the member number and its email.
    expect((await checkout(guest(items, 1, null))).totalCents).toBe(120000);
    expect((await appError(() => checkout(guest(items, 1, active.memberNo)))).fields?.memberNo).toBeTruthy();
    expect((await checkout(checkoutInputSchema.parse({ items, name: "Member 1", email: active.email, memberNo: active.memberNo }))).totalCents).toBe(100000);
  });
});

describe("orders after checkout", () => {
  it("keeps the name, size and price an order was placed at", async () => {
    const hoodie = await product();
    const order = await checkout(guest([{ variantId: size(hoodie, "M"), quantity: 1 }]));
    await updateProduct(hoodie.id, { name: "Hoodie v2", category: "apparel", description: "", priceCents: 999900, memberPriceCents: 999900, active: true }, staff.treasurer);
    await get("UPDATE product_variants SET size = 'Medium' WHERE id = ? RETURNING id", size(hoodie, "M"));

    const [stored] = await listOrders();
    expect(stored).toMatchObject({ productName: "Hoodie", size: "M", unitPriceCents: 120000, totalCents: 120000, checkoutCode: order.code });
    expect((await listTransactions({ category: "merchandise" }))[0].amountCents).toBe(120000);
  });

  it("tracks payment and hand-over separately, and only staff change either", async () => {
    const hoodie = await product();
    const buyer = await member(1);
    const order = await checkoutAsMember([{ variantId: size(hoodie, "M"), quantity: 1 }, { variantId: size(hoodie, "L"), quantity: 1 }], buyer.id);
    const [first, second] = order.lines;

    expect((await appError(() => actOnOrder(first.orderId, "fulfil", "cash", staff.treasurer))).code).toBe("payment_required");
    expect((await appError(() => actOnOrder(first.orderId, "pay", "cash", staff.organizer))).status).toBe(403);
    await actOnOrder(first.orderId, "pay", "upi", staff.treasurer);

    let mine = (await listMemberOrders(buyer.id))[0];
    expect(mine.lines.map((l) => [l.paymentStatus, l.status])).toEqual([["paid", "placed"], ["pending", "placed"]]);
    expect(mine).toMatchObject({ totalCents: 200000, unpaidCents: 100000 });

    await actOnOrder(first.orderId, "fulfil", "cash", staff.treasurer);
    await actOnOrder(second.orderId, "cancel", "cash", staff.treasurer);
    mine = (await listMemberOrders(buyer.id))[0];
    expect(mine.lines.map((l) => [l.paymentStatus, l.status])).toEqual([["paid", "fulfilled"], ["pending", "cancelled"]]);
    expect(mine).toMatchObject({ totalCents: 100000, unpaidCents: 0 });
    expect(await stockOf(hoodie, "L")).toBe(1); // the cancelled unit is back on the shelf
    expect(await getFinanceTotals()).toMatchObject({ incomeSettledCents: 150000, incomePendingCents: 0 }); // dues 500 + hoodie 1,000
  });

  it("shows a member only their own orders", async () => {
    const hoodie = await product({ variants: [{ size: "M", stock: 20 }] });
    const a = await member(1);
    const b = await member(2);
    const items = [{ variantId: size(hoodie, "M"), quantity: 1 }];
    const mine = await checkoutAsMember(items, a.id);
    await checkoutAsMember(items, b.id);
    await checkout(guest(items, 5));
    // Bought before signing in, with the same email: still theirs.
    await checkout(checkoutInputSchema.parse({ items, name: "Member 1", email: a.email.toUpperCase() }));

    const history = await listMemberOrders(a.id);
    expect(history).toHaveLength(2);
    expect(history.map((o) => o.code)).toContain(mine.code);
    expect(history.every((o) => o.buyerName === "Member 1")).toBe(true);
    expect(await listMemberOrders(b.id)).toHaveLength(1);
    expect((await appError(() => listMemberOrders("mem_missing"))).status).toBe(404);
    expect(await listOrders()).toHaveLength(4);
  });
});
