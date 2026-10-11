import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PRODUCT_IMAGES,
  checkoutInputSchema,
  memberCheckoutSchema,
  memberInputSchema,
  normaliseSizeLabel,
  productInputSchema,
  stockLevelsSchema,
  variantInputSchema,
  type Product,
} from "@/lib/contracts";
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
  setStock,
  setStockLevels,
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

describe("stock for existing sizes", () => {
  const sizes = async (p: Product) => Object.fromEntries((await getProduct(p.id)).variants.map((v) => [v.size, v.stock]));

  it("sets several sizes at once and leaves the ones not listed alone", async () => {
    const tee = await product({ name: "Tee", variants: [{ size: "S", stock: 10 }, { size: "M", stock: 0 }, { size: "L", stock: 0 }, { size: "XL", stock: 0 }] });
    const ids = tee.variants.map((v) => v.id);
    const updated = await setStockLevels(
      tee.id,
      [{ variantId: size(tee, "M"), stock: 10 }, { variantId: size(tee, "L"), stock: 15 }, { variantId: size(tee, "XL"), stock: 5 }],
      staff.treasurer,
    );
    expect(Object.fromEntries(updated.variants.map((v) => [v.size, v.stock]))).toEqual({ S: 10, M: 10, L: 15, XL: 5 });
    // Same product and the same sizes: nothing was deleted and recreated.
    expect(updated.id).toBe(tee.id);
    expect(updated.variants.map((v) => v.id)).toEqual(ids);
    expect((await listPublicProducts()).find((p) => p.id === tee.id)!.variants.map((v) => v.inStock)).toEqual([true, true, true, true]);
  });

  it("validates every quantity on the server and saves none of them if one is wrong", async () => {
    const tee = await product({ variants: [{ size: "M", stock: 3 }, { size: "L", stock: 1 }] });
    const m = size(tee, "M");
    const l = size(tee, "L");
    for (const bad of [-1, 1.5, 100001, Number.NaN, "7" as unknown as number]) {
      const error = await appError(() => setStockLevels(tee.id, [{ variantId: m, stock: 9 }, { variantId: l, stock: bad }], staff.treasurer));
      expect(error.status).toBe(422);
      expect(error.fields?.[`stock.${l}`]).toBeTruthy();
    }
    expect((await appError(() => setStock(tee.id, m, -5, staff.treasurer))).status).toBe(422);
    expect((await appError(() => setStockLevels(tee.id, [], staff.treasurer))).status).toBe(422);
    expect((await appError(() => setStockLevels(tee.id, [{ variantId: m, stock: 1 }, { variantId: m, stock: 2 }], staff.treasurer))).status).toBe(422);
    expect(await sizes(tee)).toEqual({ M: 3, L: 1 });

    // The request schema says the same thing.
    expect(stockLevelsSchema.safeParse({ levels: [{ variantId: m, stock: -1 }] }).success).toBe(false);
    expect(stockLevelsSchema.safeParse({ levels: [{ variantId: m, stock: 2.5 }] }).success).toBe(false);
    expect(stockLevelsSchema.safeParse({ levels: [] }).success).toBe(false);
    expect(stockLevelsSchema.safeParse({ levels: [{ variantId: m, stock: 0, expectedStock: 3 }] }).success).toBe(true);
  });

  it("refuses a size that belongs to another product or does not exist", async () => {
    const tee = await product({ name: "Tee", variants: [{ size: "M", stock: 3 }] });
    const cap = await product({ name: "Cap", variants: [{ size: "M", stock: 8 }] });
    expect((await appError(() => setStockLevels(tee.id, [{ variantId: size(cap, "M"), stock: 99 }], staff.treasurer))).status).toBe(404);
    expect((await appError(() => setStockLevels(tee.id, [{ variantId: "var_missing", stock: 1 }], staff.treasurer))).status).toBe(404);
    expect((await appError(() => setStockLevels("prd_missing", [{ variantId: size(tee, "M"), stock: 1 }], staff.treasurer))).status).toBe(404);
    expect(await sizes(cap)).toEqual({ M: 8 });
    expect(await sizes(tee)).toEqual({ M: 3 });
  });

  it("is only for the treasurer and president", async () => {
    const tee = await product({ variants: [{ size: "M", stock: 3 }] });
    const levels = [{ variantId: size(tee, "M"), stock: 50 }];
    const signedInMember: typeof staff.admin = { ...staff.organizer, role: "member" };
    expect((await appError(() => setStockLevels(tee.id, levels, staff.organizer))).status).toBe(403);
    expect((await appError(() => setStockLevels(tee.id, levels, signedInMember))).status).toBe(403);
    expect((await appError(() => setStockLevels(tee.id, levels, null))).status).toBe(401);
    expect(await sizes(tee)).toEqual({ M: 3 });
    expect((await setStockLevels(tee.id, levels, staff.admin)).variants[0].stock).toBe(50);
  });

  it("leaves existing orders, their prices and the ledger exactly as they were", async () => {
    const tee = await product({ variants: [{ size: "M", stock: 3 }] });
    const buyer = await member(1);
    const order = await checkoutAsMember([{ variantId: size(tee, "M"), quantity: 2 }], buyer.id);
    const before = JSON.stringify([await listOrders(), await listTransactions(), await get("SELECT * FROM products WHERE id = ?", tee.id)]);

    await setStockLevels(tee.id, [{ variantId: size(tee, "M"), stock: 40, expectedStock: 1 }], staff.treasurer);
    expect(await sizes(tee)).toEqual({ M: 40 });
    expect(JSON.stringify([await listOrders(), await listTransactions(), await get("SELECT * FROM products WHERE id = ?", tee.id)])).toBe(before);
    expect((await listMemberOrders(buyer.id))[0]).toMatchObject({ code: order.code, totalCents: 200000 });
  });

  it("does not put sold units back when the count on screen is out of date", async () => {
    const tee = await product({ variants: [{ size: "M", stock: 3 }, { size: "L", stock: 4 }] });
    const m = size(tee, "M");
    // The treasurer opened the editor (M shows 3); then someone bought one.
    await checkout(guest([{ variantId: m, quantity: 1 }]));
    const error = await appError(() =>
      setStockLevels(tee.id, [{ variantId: m, stock: 3, expectedStock: 3 }, { variantId: size(tee, "L"), stock: 9, expectedStock: 4 }], staff.treasurer),
    );
    expect(error).toMatchObject({ code: "stock_changed", status: 409 });
    expect(error.fields?.[`stock.${m}`]).toContain("2");
    expect(await sizes(tee)).toEqual({ M: 2, L: 4 }); // neither size was saved
    await setStockLevels(tee.id, [{ variantId: m, stock: 3, expectedStock: 2 }], staff.treasurer);
    expect(await sizes(tee)).toEqual({ M: 3, L: 4 });
  });

  it("cannot be raced into overselling by simultaneous buyers and a stock change", async () => {
    const tee = await product({ variants: [{ size: "M", stock: 2 }] });
    const m = size(tee, "M");
    const outcomes = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) =>
        checkout(guest([{ variantId: m, quantity: 1 }], i)).then(() => "sold", () => "refused"),
      ),
      setStockLevels(tee.id, [{ variantId: m, stock: 4 }], staff.treasurer).then(() => "restocked", () => "refused"),
    ]);
    const sold = outcomes.filter((o) => o === "sold").length;
    const left = (await sizes(tee)).M;
    expect(left).toBeGreaterThanOrEqual(0);
    expect((await listOrders()).reduce((sum, o) => sum + o.quantity, 0)).toBe(sold);
    expect(sold).toBeLessThanOrEqual(6); // never more orders than units that ever existed (2 + 4)
    expect(outcomes).toContain("restocked");
  });
});

describe("size labels", () => {
  it("are normalised, so the same size cannot be added twice in another spelling", async () => {
    expect(["xl", " XL ", "Xl", "2xl", "m", "32", "One size", "  one   size ", "Extra Large"].map(normaliseSizeLabel)).toEqual([
      "XL", "XL", "XL", "2XL", "M", "32", "One size", "one size", "Extra Large",
    ]);
    const tee = await product({ variants: [{ size: "s", stock: 1 }, { size: "One size", stock: 1 }] });
    expect(tee.variants.map((v) => v.size)).toEqual(["S", "One size"]);

    const added = await addVariant(tee.id, variantInputSchema.parse({ size: " xxl ", stock: 6 }), staff.treasurer);
    expect(added.variants.map((v) => [v.size, v.stock])).toEqual([["S", 1], ["One size", 1], ["XXL", 6]]);
    for (const duplicate of ["XXL", "xxl", " Xxl ", "S", "one  SIZE"]) {
      const error = await appError(() => addVariant(tee.id, { size: duplicate, stock: 1 }, staff.treasurer));
      expect(error.fields?.size, duplicate).toBeTruthy();
    }
    expect((await getProduct(tee.id)).variants).toHaveLength(3);
    expect(productInputSchema.safeParse({ name: "Dup", priceCents: 100, memberPriceCents: 100, variants: [{ size: "m", stock: 1 }, { size: " M ", stock: 1 }] }).success).toBe(false);
  });

  it("rejects a bad starting stock for a new size", async () => {
    const tee = await product({ variants: [{ size: "M", stock: 1 }] });
    for (const bad of [-1, 2.5, 100001]) {
      expect((await appError(() => addVariant(tee.id, { size: "L", stock: bad }, staff.treasurer))).fields?.stock).toBeTruthy();
      expect(variantInputSchema.safeParse({ size: "L", stock: bad }).success).toBe(false);
    }
    expect((await appError(() => addVariant(tee.id, { size: "   ", stock: 1 }, staff.treasurer))).fields?.size).toBeTruthy();
    expect((await getProduct(tee.id)).variants).toHaveLength(1);
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
