import {
  MAX_PRODUCT_IMAGES,
  can,
  normaliseSizeLabel,
  type CheckoutInput,
  type Order,
  type OrderInput,
  type OrderLine,
  type OrderStatus,
  type PaymentMethod,
  type Product,
  type ProductCategory,
  type ProductImage,
  type ProductInput,
  type PublicOrder,
  type PublicProduct,
  type SessionUser,
  type ShopOrder,
} from "@/lib/contracts";
import { all, get, newId, nowIso, randomCode, run, tx } from "../db";
import { AppError, conflict, forbidden, invalid, notFound, requireRole } from "../errors";
import { discardFile, openFile, storeImage, type StoredFile } from "../storage";
import { payableOnline } from "../razorpay";
import { recordTransaction, settlePendingFor, voidPendingFor } from "./finance";
import { findActiveMember } from "./members";

/**
 * Merchandise, stock and checkout. Stock only ever changes through this file:
 * a checkout takes units with a conditional UPDATE, a cancellation gives them
 * back. Prices are read from the product at checkout; nothing a browser sends
 * about price or total is used.
 */

interface ProductRow {
  id: string;
  name: string;
  category: ProductCategory;
  description: string;
  price_cents: number;
  member_price_cents: number;
  active: number;
}
interface VariantRow {
  id: string;
  product_id: string;
  size: string;
  stock: number;
}

const imageUrl = (fileId: string) => `/api/public/product-images/${fileId}`;

async function loadProducts(where = "", ...params: string[]): Promise<Product[]> {
  const products = await all<ProductRow>(`SELECT * FROM products ${where} ORDER BY created_at ASC`, ...params);
  const variants = await all<VariantRow>("SELECT * FROM product_variants ORDER BY position ASC");
  const images = await all<{ id: string; product_id: string; file_id: string }>(
    "SELECT id, product_id, file_id FROM product_images ORDER BY position ASC, created_at ASC",
  );
  const sold = new Map(
    (await all<{ product_id: string; units: number }>(
      "SELECT product_id, SUM(quantity) AS units FROM orders WHERE status <> 'cancelled' GROUP BY product_id",
    )).map((r) => [r.product_id, r.units]),
  );
  return products.map((p) => {
    const own = variants.filter((v) => v.product_id === p.id);
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      description: p.description,
      priceCents: p.price_cents,
      memberPriceCents: p.member_price_cents,
      active: p.active === 1,
      images: images.filter((i) => i.product_id === p.id).map((i): ProductImage => ({ id: i.id, url: imageUrl(i.file_id) })),
      variants: own.map((v) => ({ id: v.id, size: v.size, stock: v.stock })),
      totalStock: own.reduce((sum, v) => sum + v.stock, 0),
      unitsSold: sold.get(p.id) ?? 0,
    };
  });
}

export async function listProducts(): Promise<Product[]> {
  return loadProducts();
}

export async function getProduct(id: string): Promise<Product> {
  const product = (await loadProducts("WHERE id = ?", id))[0];
  if (!product) throw notFound("Product");
  return product;
}

const toPublicProduct = (p: Product): PublicProduct => ({
  id: p.id,
  name: p.name,
  category: p.category,
  description: p.description,
  priceCents: p.priceCents,
  memberPriceCents: p.memberPriceCents,
  images: p.images,
  variants: p.variants.map((v) => ({ id: v.id, size: v.size, inStock: v.stock > 0, stock: v.stock })),
});

export async function listPublicProducts(): Promise<PublicProduct[]> {
  return (await loadProducts("WHERE active = 1")).map(toPublicProduct);
}

/** One product for the shop. A deactivated product looks the same as a missing one. */
export async function getPublicProduct(id: string): Promise<PublicProduct> {
  const product = (await loadProducts("WHERE id = ? AND active = 1", id))[0];
  if (!product) throw notFound("Product");
  return toPublicProduct(product);
}

export async function createProduct(input: ProductInput, actor: SessionUser | null): Promise<Product> {
  requireRole(actor, "admin", "treasurer");
  return tx(async () => {
    const id = newId("prd");
    await run(
      `INSERT INTO products (id, name, category, description, price_cents, member_price_cents, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.category,
      input.description,
      input.priceCents,
      input.memberPriceCents,
      input.active,
      nowIso(),
    );
    for (const [position, v] of input.variants.entries()) {
      await run(
        "INSERT INTO product_variants (id, product_id, size, stock, position) VALUES (?, ?, ?, ?, ?)",
        newId("var"),
        id,
        v.size,
        v.stock,
        position,
      );
    }
    return getProduct(id);
  });
}

export async function updateProduct(
  id: string,
  input: {
    name: string;
    category: ProductCategory;
    description: string;
    priceCents: number;
    memberPriceCents: number;
    active: boolean;
  },
  actor: SessionUser | null,
): Promise<Product> {
  requireRole(actor, "admin", "treasurer");
  if (input.memberPriceCents > input.priceCents) {
    throw invalid("Check the prices.", {
      memberPriceCents: "Member price cannot be higher than the standard price",
    });
  }
  const result = await run(
    `UPDATE products SET name = ?, category = ?, description = ?, price_cents = ?, member_price_cents = ?, active = ?
     WHERE id = ?`,
    input.name,
    input.category,
    input.description,
    input.priceCents,
    input.memberPriceCents,
    input.active,
    id,
  );
  if (result.changes !== 1) throw notFound("Product");
  return getProduct(id);
}

const MAX_STOCK = 100000;
const validStock = (stock: unknown): stock is number =>
  typeof stock === "number" && Number.isInteger(stock) && stock >= 0 && stock <= MAX_STOCK;

/** Sets the counted stock for one size, e.g. after a delivery or a stock-take. */
export async function setStock(
  productId: string,
  variantId: string,
  stock: number,
  actor: SessionUser | null,
): Promise<Product> {
  return setStockLevels(productId, [{ variantId, stock }], actor);
}

/**
 * Sets the counted stock of several sizes of one product at once. All of them
 * are saved or none. Sizes that are not listed are left exactly as they are.
 *
 * It runs in the same kind of transaction as a checkout, so it can never
 * interleave with one. When `expectedStock` is given and the size's stock is
 * no longer that number, the whole update is refused: someone bought or
 * cancelled while the screen was open, and saving the typed count would
 * silently undo it.
 */
export async function setStockLevels(
  productId: string,
  levels: { variantId: string; stock: number; expectedStock?: number }[],
  actor: SessionUser | null,
): Promise<Product> {
  requireRole(actor, "admin", "treasurer");
  // Checked here as well as in the request schema, so no caller can store a bad count.
  const fields: Record<string, string> = {};
  const seen = new Set<string>();
  for (const level of levels) {
    if (!validStock(level.stock)) fields[`stock.${level.variantId}`] = "Enter a whole number from 0 to 100,000";
    if (seen.has(level.variantId)) fields[`stock.${level.variantId}`] = "This size is listed twice";
    seen.add(level.variantId);
  }
  if (levels.length === 0) throw invalid("Change at least one size.");
  if (Object.keys(fields).length > 0) throw invalid("Check the stock quantities.", fields);

  return tx(async () => {
    const current = new Map(
      (await all<VariantRow>("SELECT * FROM product_variants WHERE product_id = ?", productId)).map((v) => [v.id, v]),
    );
    if (current.size === 0 && !(await get("SELECT 1 FROM products WHERE id = ?", productId))) throw notFound("Product");
    const stale: Record<string, string> = {};
    for (const level of levels) {
      const variant = current.get(level.variantId);
      if (!variant) throw notFound("Size");
      if (level.expectedStock !== undefined && variant.stock !== level.expectedStock) {
        stale[`stock.${level.variantId}`] = `This changed to ${variant.stock} while you were editing. Check it and save again.`;
      }
    }
    if (Object.keys(stale).length > 0) {
      throw new AppError("stock_changed", "Stock changed while you were editing. Nothing was saved.", 409, stale);
    }
    for (const level of levels) {
      await run(
        "UPDATE product_variants SET stock = ? WHERE id = ? AND product_id = ?",
        level.stock,
        level.variantId,
        productId,
      );
    }
    return getProduct(productId);
  });
}

/** Adds a size to a product that already exists. */
export async function addVariant(
  productId: string,
  input: { size: string; stock: number },
  actor: SessionUser | null,
): Promise<Product> {
  requireRole(actor, "admin", "treasurer");
  const size = normaliseSizeLabel(input.size);
  if (!size || size.length > 20) throw invalid("Check the size.", { size: "Enter a size name of up to 20 characters" });
  if (!validStock(input.stock)) throw invalid("Check the stock.", { stock: "Enter a whole number from 0 to 100,000" });
  return tx(async () => {
    const product = await getProduct(productId);
    if (product.variants.some((v) => normaliseSizeLabel(v.size).toLowerCase() === size.toLowerCase())) {
      throw invalid("This size already exists.", { size: `${product.name} already has size ${size}` });
    }
    if (product.variants.length >= 12) throw invalid("Too many sizes.", { size: "A product can have at most 12 sizes" });
    await run(
      "INSERT INTO product_variants (id, product_id, size, stock, position) VALUES (?, ?, ?, ?, ?)",
      newId("var"),
      productId,
      size,
      input.stock,
      product.variants.length,
    );
    return getProduct(productId);
  });
}

// --- product photos ------------------------------------------------------------

export async function addProductImage(productId: string, bytes: Buffer | null, actor: SessionUser | null): Promise<Product> {
  requireRole(actor, "admin", "treasurer");
  if (!bytes) throw invalid("Choose a photo.", { image: "Choose a photo to upload" });
  let fileId = null as string | null;
  try {
    return tx(async () => {
      const product = await getProduct(productId);
      if (product.images.length >= MAX_PRODUCT_IMAGES) {
        throw invalid("Too many photos.", { image: `A product can have at most ${MAX_PRODUCT_IMAGES} photos` });
      }
      fileId = await storeImage(bytes, "product_image", "image");
      await run(
        "INSERT INTO product_images (id, product_id, file_id, position, created_at) VALUES (?, ?, ?, ?, ?)",
        newId("img"),
        productId,
        fileId,
        product.images.length,
        nowIso(),
      );
      return getProduct(productId);
    });
  } catch (error) {
    if (fileId) await discardFile(fileId);
    throw error;
  }
}

export async function removeProductImage(productId: string, imageId: string, actor: SessionUser | null): Promise<Product> {
  requireRole(actor, "admin", "treasurer");
  const fileId = await tx(async () => {
    const row = await get<{ file_id: string }>(
      "SELECT file_id FROM product_images WHERE id = ? AND product_id = ?",
      imageId,
      productId,
    );
    if (!row) throw notFound("Photo");
    await run("DELETE FROM product_images WHERE id = ?", imageId);
    await run("DELETE FROM files WHERE id = ?", row.file_id);
    return row.file_id;
  });
  await discardFile(fileId);
  return getProduct(productId);
}

/**
 * A product photo, for anyone. Only files recorded as product photos are
 * served this way; evidence uploads share the storage but never this route.
 */
export async function readProductImage(fileId: string): Promise<StoredFile> {
  if (!await get("SELECT 1 FROM product_images WHERE file_id = ?", fileId)) throw notFound("Photo");
  return openFile(fileId);
}

// --- orders --------------------------------------------------------------------

interface OrderRow {
  id: string;
  code: string;
  product_id: string;
  variant_id: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  buyer_name: string;
  buyer_email: string;
  member_id: string | null;
  payment_status: "pending" | "paid";
  status: OrderStatus;
  created_at: string;
  checkout_id: string | null;
  product_name: string;
  size: string;
  member_no: string | null;
  checkout_code: string | null;
}

/**
 * Whose order it is, for a member's own list and for paying online. An order
 * belongs to a member when it was placed from their signed-in account
 * (recorded on the checkout), or as a guest who proved the membership with the
 * member number and its email (recorded on the order).
 *
 * The email typed at checkout is never enough: anyone can type any email, so
 * matching on it would put a stranger's order in a member's list.
 * Takes the member id twice.
 */
const OWNED_BY_MEMBER = "(o.member_id = ? OR c.member_id = ?)";

// The name and size a line was sold as win over the product's current ones.
const ORDER_SELECT = `
  SELECT o.id, o.code, o.product_id, o.variant_id, o.quantity, o.unit_price_cents, o.total_cents,
         o.buyer_name, o.buyer_email, o.member_id, o.payment_status, o.status, o.created_at, o.checkout_id,
         COALESCE(o.product_name, p.name) AS product_name, COALESCE(o.size_label, v.size) AS size,
         m.member_no AS member_no, c.code AS checkout_code
  FROM orders o
  JOIN products p ON p.id = o.product_id
  JOIN product_variants v ON v.id = o.variant_id
  LEFT JOIN members m ON m.id = o.member_id
  LEFT JOIN checkouts c ON c.id = o.checkout_id`;

const toOrder = (r: OrderRow): Order => ({
  id: r.id,
  code: r.code,
  checkoutCode: r.checkout_code,
  productId: r.product_id,
  productName: r.product_name,
  size: r.size,
  quantity: r.quantity,
  unitPriceCents: r.unit_price_cents,
  totalCents: r.total_cents,
  buyerName: r.buyer_name,
  buyerEmail: r.buyer_email,
  memberNo: r.member_no,
  paymentStatus: r.payment_status,
  status: r.status,
  createdAt: r.created_at,
});

const toLine = (r: OrderRow): OrderLine => ({
  orderId: r.id,
  productId: r.product_id,
  productName: r.product_name,
  size: r.size,
  quantity: r.quantity,
  unitPriceCents: r.unit_price_cents,
  totalCents: r.total_cents,
  paymentStatus: r.payment_status,
  status: r.status,
});

export async function listOrders(): Promise<Order[]> {
  return (await all<OrderRow>(`${ORDER_SELECT} ORDER BY o.created_at DESC, o.checkout_id, o.line_no, o.id`)).map(toOrder);
}

async function getOrderRow(id: string): Promise<OrderRow> {
  const row = await get<OrderRow>(`${ORDER_SELECT} WHERE o.id = ?`, id);
  if (!row) throw notFound("Order");
  return row;
}

function toShopOrder(
  head: { code: string; created_at: string; buyer_name: string; member_id: string | null },
  rows: OrderRow[],
  /** True when the result goes to the signed-in member the order belongs to. */
  forOwner = false,
): ShopOrder {
  const live = rows.filter((r) => r.status !== "cancelled");
  const unpaidCents = live.filter((r) => r.payment_status === "pending").reduce((sum, r) => sum + r.total_cents, 0);
  return {
    code: head.code,
    createdAt: head.created_at,
    buyerName: head.buyer_name,
    isMember: head.member_id !== null,
    totalCents: live.reduce((sum, r) => sum + r.total_cents, 0),
    unpaidCents,
    payOnline: forOwner && unpaidCents > 0 && payableOnline(unpaidCents),
    lines: rows.map(toLine),
  };
}

async function uniqueCode(prefix: string, table: "orders" | "checkouts"): Promise<string> {
  let code = `${prefix}-${randomCode(6)}`;
  while (await get(`SELECT 1 FROM ${table} WHERE code = ?`, code)) code = `${prefix}-${randomCode(6)}`;
  return code;
}

interface Buyer {
  name: string;
  email: string;
  /** Set when the member price applies: an active member, already verified by the caller. */
  memberId: string | null;
  /**
   * The member whose signed-in account placed the order, whether or not the
   * member price applied. Kept on the checkout, so the order is theirs by
   * record and not by whatever email was typed.
   */
  ownerMemberId?: string | null;
}

/**
 * Places every line of a cart, or none of them. Runs in one write
 * transaction: if any size is short, the stock taken for earlier lines is
 * rolled back with everything else. Call inside `tx`.
 */
async function placeLines(
  lines: { variantId: string; quantity: number }[],
  buyer: Buyer,
  /** The buyer is a signed-in member, who can go on to pay online. */
  signedIn = false,
): Promise<ShopOrder> {
  // The same size listed twice is one line.
  const wanted = new Map<string, number>();
  for (const line of lines) wanted.set(line.variantId, (wanted.get(line.variantId) ?? 0) + line.quantity);

  const checkoutId = newId("chk");
  const checkoutCode = await uniqueCode("CHK", "checkouts");
  const ts = nowIso();
  const priced: { product: ProductRow; variant: VariantRow; quantity: number; unit: number }[] = [];

  for (const [variantId, quantity] of wanted) {
    const variant = await get<VariantRow>("SELECT * FROM product_variants WHERE id = ?", variantId);
    const product = variant && await get<ProductRow>("SELECT * FROM products WHERE id = ? AND active = 1", variant.product_id);
    if (!variant || !product) {
      throw invalid("Something in your cart is no longer for sale.", { variantId: "This size is not available" });
    }
    if (quantity > 10) {
      throw invalid("That is more than one order allows.", { quantity: "At most 10 of one size per order" });
    }
    // Take the units only if they are all still there. Two buyers racing for
    // the last hoodie cannot both pass this statement.
    const taken = await run(
      "UPDATE product_variants SET stock = stock - ? WHERE id = ? AND stock >= ?",
      quantity,
      variant.id,
      quantity,
    );
    if (taken.changes !== 1) {
      throw conflict(
        "out_of_stock",
        variant.stock === 0
          ? `${product.name} in size ${variant.size} is sold out.`
          : `Only ${variant.stock} left of ${product.name} in size ${variant.size}.`,
      );
    }
    // The price comes from the product row, never from the request.
    priced.push({ product, variant, quantity, unit: buyer.memberId ? product.member_price_cents : product.price_cents });
  }

  const totalCents = priced.reduce((sum, l) => sum + l.unit * l.quantity, 0);
  await run(
    "INSERT INTO checkouts (id, code, buyer_name, buyer_email, member_id, total_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    checkoutId,
    checkoutCode,
    buyer.name,
    buyer.email,
    buyer.ownerMemberId ?? buyer.memberId,
    totalCents,
    ts,
  );

  for (const [index, line] of priced.entries()) {
    const id = newId("ord");
    const code = await uniqueCode("ORD", "orders");
    const lineTotal = line.unit * line.quantity;
    await run(
      `INSERT INTO orders
         (id, code, product_id, variant_id, quantity, unit_price_cents, total_cents, buyer_name,
          buyer_email, member_id, payment_status, status, created_at, checkout_id, product_name, size_label, line_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'placed', ?, ?, ?, ?, ?)`,
      id,
      code,
      line.product.id,
      line.variant.id,
      line.quantity,
      line.unit,
      lineTotal,
      buyer.name,
      buyer.email,
      buyer.memberId,
      ts,
      checkoutId,
      line.product.name,
      line.variant.size,
      index + 1,
    );
    // Owed, not collected: the order stays unpaid until staff record the payment.
    await recordTransaction({
      type: "income",
      category: "merchandise",
      amountCents: lineTotal,
      status: "pending",
      description: `Order ${code} — ${line.quantity} × ${line.product.name} (${line.variant.size})`,
      counterparty: buyer.name,
      source: "order",
      orderId: id,
      memberId: buyer.memberId,
    });
  }

  return toShopOrder(
    { code: checkoutCode, created_at: ts, buyer_name: buyer.name, member_id: buyer.memberId },
    await all<OrderRow>(`${ORDER_SELECT} WHERE o.checkout_id = ? ORDER BY o.line_no, o.id`, checkoutId),
    signedIn,
  );
}

/** A visitor checks out. The member price needs a member number and email that match an active member. */
export async function checkout(input: CheckoutInput): Promise<ShopOrder> {
  return tx(async () => {
    let memberId: string | null = null;
    if (input.memberNo) {
      const member = await findActiveMember(input.email, input.memberNo);
      if (!member) {
        throw invalid("We could not apply the member price.", {
          memberNo:
            "This member number and email do not match an active, paid-up membership. Clear the field to pay the standard price.",
        });
      }
      memberId = member.id;
    }
    return placeLines(input.items, { name: input.name, email: input.email, memberId });
  });
}

/**
 * A signed-in member checks out. Their name and email come from their member
 * record, and the member price applies only while a paid term covers today.
 */
export async function checkoutAsMember(items: { variantId: string; quantity: number }[], memberId: string): Promise<ShopOrder> {
  return tx(async () => {
    const member = await get<{ name: string; email: string; member_no: string }>(
      "SELECT name, email, member_no FROM members WHERE id = ?",
      memberId,
    );
    if (!member) throw notFound("Member");
    const active = await findActiveMember(member.email, member.member_no);
    return placeLines(items, { name: member.name, email: member.email, memberId: active ? active.id : null, ownerMemberId: memberId }, true);
  });
}

/** Orders one product in one size. Kept for the staff desk and older callers; it is a one-line checkout. */
export async function placeOrder(input: OrderInput): Promise<PublicOrder> {
  return tx(async () => {
    if (!await get("SELECT 1 FROM products WHERE id = ? AND active = 1", input.productId)) throw notFound("Product");
    if (!await get("SELECT 1 FROM product_variants WHERE id = ? AND product_id = ?", input.variantId, input.productId)) {
      throw invalid("Choose a size.", { variantId: "This size is not available" });
    }
    const order = await checkout({
      items: [{ variantId: input.variantId, quantity: input.quantity }],
      name: input.name,
      email: input.email,
      memberNo: input.memberNo,
    });
    const line = order.lines[0];
    const code = (await get<{ code: string }>("SELECT code FROM orders WHERE id = ?", line.orderId))!.code;
    return {
      code,
      productName: line.productName,
      size: line.size,
      quantity: line.quantity,
      totalCents: line.totalCents,
      isMember: order.isMember,
      paymentStatus: "pending",
    };
  });
}

/**
 * A member's order history: checkouts placed with their member account or
 * under their email, newest first. Orders that predate checkouts appear as
 * single-line orders. Nobody else's orders can appear here.
 */
export async function listMemberOrders(memberId: string): Promise<ShopOrder[]> {
  if (!await get("SELECT 1 FROM members WHERE id = ?", memberId)) throw notFound("Member");
  const rows = await all<OrderRow>(
    `${ORDER_SELECT} WHERE ${OWNED_BY_MEMBER} ORDER BY o.created_at DESC, o.checkout_id, o.line_no, o.id`,
    memberId,
    memberId,
  );
  const groups = new Map<string, OrderRow[]>();
  for (const row of rows) {
    const key = row.checkout_id ?? row.id;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) =>
    toShopOrder(
      {
        code: group[0].checkout_code ?? group[0].code,
        created_at: group[0].created_at,
        buyer_name: group[0].buyer_name,
        member_id: group[0].member_id,
      },
      group,
      true,
    ),
  );
}

/**
 * One of a member's own orders, by its order number, with the lines that are
 * still owed. Ownership is the same rule as the order history above; an order
 * that is not theirs is reported as not found, the same as one that does not exist.
 */
export async function memberOrder(
  memberId: string,
  code: string,
): Promise<{ order: ShopOrder; owed: { orderId: string; amountCents: number }[] }> {
  if (!await get("SELECT 1 FROM members WHERE id = ?", memberId)) throw notFound("Member");
  const wanted = code.trim().toUpperCase();
  const rows = await all<OrderRow>(
    `${ORDER_SELECT}
     WHERE (c.code = ? OR (o.checkout_id IS NULL AND o.code = ?)) AND ${OWNED_BY_MEMBER}
     ORDER BY o.line_no, o.id`,
    wanted,
    wanted,
    memberId,
    memberId,
  );
  if (rows.length === 0) throw notFound("Order");
  return {
    order: toShopOrder(
      {
        code: rows[0].checkout_code ?? rows[0].code,
        created_at: rows[0].created_at,
        buyer_name: rows[0].buyer_name,
        member_id: rows[0].member_id,
      },
      rows,
      true,
    ),
    // Prices come from the order rows as they were placed, never from the request.
    owed: rows
      .filter((r) => r.status !== "cancelled" && r.payment_status === "pending")
      .map((r) => ({ orderId: r.id, amountCents: r.total_cents })),
  };
}

export interface OrderActionResult {
  order: Order;
  /** Set when a paid order was cancelled and a refund is now owed. */
  refundDueCents: number;
}

/**
 * True when the order is the acting committee account's own: placed by or for
 * the member that account is linked to, or placed as a guest with the
 * account's own email. The link is read from the database, not from the session object.
 */
async function isOwnOrder(orderId: string, buyerEmail: string, user: SessionUser): Promise<boolean> {
  const account = await get<{ email: string; member_id: string | null }>("SELECT email, member_id FROM users WHERE id = ?", user.id);
  if (!account) return false;
  if (buyerEmail.toLowerCase() === account.email.toLowerCase()) return true;
  if (!account.member_id) return false;
  return !!(await get(
    `SELECT 1 FROM orders o LEFT JOIN checkouts c ON c.id = o.checkout_id WHERE o.id = ? AND ${OWNED_BY_MEMBER}`,
    orderId,
    account.member_id,
    account.member_id,
  ));
}

export async function actOnOrder(
  id: string,
  action: "pay" | "fulfil" | "cancel",
  method: PaymentMethod,
  actor: SessionUser | null,
): Promise<OrderActionResult> {
  const user = requireRole(actor, "admin", "treasurer");
  return tx(async () => {
    const row = await getOrderRow(id);
    let refundDueCents = 0;
    if (row.status === "cancelled") throw conflict("order_cancelled", "This order was cancelled.");

    if (action === "pay") {
      if (row.payment_status === "paid") throw conflict("not_pending", "This order is already paid.");
      // Nobody records the payment for their own order: someone else on the committee does, or it is paid online.
      if (await isOwnOrder(id, row.buyer_email, user)) {
        throw forbidden("This is your own order. Pay it online, or ask another committee member to record the payment.");
      }
      await settlePendingFor({ orderId: id }, method);
    }

    if (action === "fulfil") {
      if (row.status === "fulfilled") throw conflict("already_fulfilled", "This order was already handed over.");
      if (row.payment_status !== "paid") {
        throw conflict("payment_required", "Collect payment before handing the item over.");
      }
      await run("UPDATE orders SET status = 'fulfilled' WHERE id = ?", id);
    }

    if (action === "cancel") {
      if (row.status === "fulfilled") {
        throw conflict("already_fulfilled", "This order was already handed over and cannot be cancelled.");
      }
      // Cancelling a paid order records a refund owed, which is the president's decision.
      if (row.payment_status !== "pending" && !can(user, "processRefunds")) {
        throw forbidden("This order is paid. Only the president can cancel it, because that records a refund.");
      }
      await run("UPDATE orders SET status = 'cancelled' WHERE id = ?", id);
      await run("UPDATE product_variants SET stock = stock + ? WHERE id = ?", row.quantity, row.variant_id);
      if (row.payment_status === "pending") {
        await voidPendingFor({ orderId: id }, "Order cancelled");
      } else {
        refundDueCents = row.total_cents;
        await recordTransaction({
          type: "expense",
          category: "refund",
          amountCents: row.total_cents,
          status: "pending",
          description: `Refund due for cancelled order ${row.code}`,
          counterparty: row.buyer_name,
          source: "refund",
          orderId: id,
          memberId: row.member_id,
          createdBy: user.id,
        });
      }
    }
    return { order: toOrder(await getOrderRow(id)), refundDueCents };
  });
}
