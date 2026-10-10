import type {
  Order,
  OrderInput,
  OrderStatus,
  PaymentMethod,
  Product,
  ProductInput,
  PublicOrder,
  PublicProduct,
  SessionUser,
} from "@/lib/contracts";
import { all, get, newId, nowIso, randomCode, run, tx } from "../db";
import { conflict, invalid, notFound, requireRole } from "../errors";
import { recordTransaction, settlePendingFor, voidPendingFor } from "./finance";
import { findActiveMember } from "./members";

/**
 * Merchandise and stock. Stock only ever changes through this file: an order
 * takes units with a conditional UPDATE, a cancellation gives them back.
 */

interface ProductRow {
  id: string;
  name: string;
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

function loadProducts(where = ""): Product[] {
  const products = all<ProductRow>(`SELECT * FROM products ${where} ORDER BY created_at ASC`);
  const variants = all<VariantRow>("SELECT * FROM product_variants ORDER BY position ASC");
  const sold = new Map(
    all<{ product_id: string; units: number }>(
      "SELECT product_id, SUM(quantity) AS units FROM orders WHERE status <> 'cancelled' GROUP BY product_id",
    ).map((r) => [r.product_id, r.units]),
  );
  return products.map((p) => {
    const own = variants.filter((v) => v.product_id === p.id);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      priceCents: p.price_cents,
      memberPriceCents: p.member_price_cents,
      active: p.active === 1,
      variants: own.map((v) => ({ id: v.id, size: v.size, stock: v.stock })),
      totalStock: own.reduce((sum, v) => sum + v.stock, 0),
      unitsSold: sold.get(p.id) ?? 0,
    };
  });
}

export function listProducts(): Product[] {
  return loadProducts();
}

export function getProduct(id: string): Product {
  const product = loadProducts().find((p) => p.id === id);
  if (!product) throw notFound("Product");
  return product;
}

export function listPublicProducts(): PublicProduct[] {
  return loadProducts("WHERE active = 1").map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    priceCents: p.priceCents,
    memberPriceCents: p.memberPriceCents,
    variants: p.variants.map((v) => ({ id: v.id, size: v.size, inStock: v.stock > 0, stock: v.stock })),
  }));
}

export function createProduct(input: ProductInput, actor: SessionUser | null): Product {
  requireRole(actor, "admin", "treasurer");
  return tx(() => {
    const id = newId("prd");
    run(
      `INSERT INTO products (id, name, description, price_cents, member_price_cents, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.description,
      input.priceCents,
      input.memberPriceCents,
      input.active,
      nowIso(),
    );
    input.variants.forEach((v, position) => {
      run(
        "INSERT INTO product_variants (id, product_id, size, stock, position) VALUES (?, ?, ?, ?, ?)",
        newId("var"),
        id,
        v.size,
        v.stock,
        position,
      );
    });
    return getProduct(id);
  });
}

export function updateProduct(
  id: string,
  input: { name: string; description: string; priceCents: number; memberPriceCents: number; active: boolean },
  actor: SessionUser | null,
): Product {
  requireRole(actor, "admin", "treasurer");
  if (input.memberPriceCents > input.priceCents) {
    throw invalid("Check the prices.", {
      memberPriceCents: "Member price cannot be higher than the standard price",
    });
  }
  const result = run(
    "UPDATE products SET name = ?, description = ?, price_cents = ?, member_price_cents = ?, active = ? WHERE id = ?",
    input.name,
    input.description,
    input.priceCents,
    input.memberPriceCents,
    input.active,
    id,
  );
  if (result.changes !== 1) throw notFound("Product");
  return getProduct(id);
}

/** Sets the counted stock for one size, e.g. after a delivery or a stock-take. */
export function setStock(
  productId: string,
  variantId: string,
  stock: number,
  actor: SessionUser | null,
): Product {
  requireRole(actor, "admin", "treasurer");
  const result = run(
    "UPDATE product_variants SET stock = ? WHERE id = ? AND product_id = ?",
    stock,
    variantId,
    productId,
  );
  if (result.changes !== 1) throw notFound("Size");
  return getProduct(productId);
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
  product_name: string;
  size: string;
  member_no: string | null;
}

const ORDER_SELECT = `
  SELECT o.*, p.name AS product_name, v.size AS size, m.member_no AS member_no
  FROM orders o
  JOIN products p ON p.id = o.product_id
  JOIN product_variants v ON v.id = o.variant_id
  LEFT JOIN members m ON m.id = o.member_id`;

const toOrder = (r: OrderRow): Order => ({
  id: r.id,
  code: r.code,
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

export function listOrders(): Order[] {
  return all<OrderRow>(`${ORDER_SELECT} ORDER BY o.created_at DESC`).map(toOrder);
}

function getOrderRow(id: string): OrderRow {
  const row = get<OrderRow>(`${ORDER_SELECT} WHERE o.id = ?`, id);
  if (!row) throw notFound("Order");
  return row;
}

/** A member or visitor orders from the public shop. Payment is collected later by staff. */
export function placeOrder(input: OrderInput): PublicOrder {
  return tx(() => {
    const product = get<ProductRow>("SELECT * FROM products WHERE id = ? AND active = 1", input.productId);
    if (!product) throw notFound("Product");
    const variant = get<VariantRow>(
      "SELECT * FROM product_variants WHERE id = ? AND product_id = ?",
      input.variantId,
      input.productId,
    );
    if (!variant) throw invalid("Choose a size.", { variantId: "This size is not available" });

    let memberId: string | null = null;
    if (input.memberNo) {
      const member = findActiveMember(input.email, input.memberNo);
      if (!member) {
        throw invalid("We could not apply the member price.", {
          memberNo:
            "This member number and email do not match an active, paid-up membership. Clear the field to pay the standard price.",
        });
      }
      memberId = member.id;
    }

    // Take the units only if they are all still there. Two buyers racing for
    // the last hoodie cannot both pass this statement.
    const taken = run(
      "UPDATE product_variants SET stock = stock - ? WHERE id = ? AND stock >= ?",
      input.quantity,
      variant.id,
      input.quantity,
    );
    if (taken.changes !== 1) {
      throw conflict(
        "out_of_stock",
        variant.stock === 0
          ? `${product.name} in size ${variant.size} is sold out.`
          : `Only ${variant.stock} left of ${product.name} in size ${variant.size}.`,
      );
    }

    const unitPriceCents = memberId ? product.member_price_cents : product.price_cents;
    const totalCents = unitPriceCents * input.quantity;
    const id = newId("ord");
    let code = `ORD-${randomCode(6)}`;
    while (get("SELECT 1 FROM orders WHERE code = ?", code)) code = `ORD-${randomCode(6)}`;

    run(
      `INSERT INTO orders
         (id, code, product_id, variant_id, quantity, unit_price_cents, total_cents, buyer_name,
          buyer_email, member_id, payment_status, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'placed', ?)`,
      id,
      code,
      product.id,
      variant.id,
      input.quantity,
      unitPriceCents,
      totalCents,
      input.name,
      input.email,
      memberId,
      nowIso(),
    );
    recordTransaction({
      type: "income",
      category: "merchandise",
      amountCents: totalCents,
      status: "pending",
      description: `Order ${code} — ${input.quantity} × ${product.name} (${variant.size})`,
      counterparty: input.name,
      source: "order",
      orderId: id,
      memberId,
    });

    return {
      code,
      productName: product.name,
      size: variant.size,
      quantity: input.quantity,
      totalCents,
      isMember: memberId !== null,
      paymentStatus: "pending",
    };
  });
}

export interface OrderActionResult {
  order: Order;
  /** Set when a paid order was cancelled and a refund is now owed. */
  refundDueCents: number;
}

export function actOnOrder(
  id: string,
  action: "pay" | "fulfil" | "cancel",
  method: PaymentMethod,
  actor: SessionUser | null,
): OrderActionResult {
  const user = requireRole(actor, "admin", "treasurer");
  return tx(() => {
    const row = getOrderRow(id);
    let refundDueCents = 0;
    if (row.status === "cancelled") throw conflict("order_cancelled", "This order was cancelled.");

    if (action === "pay") {
      if (row.payment_status === "paid") throw conflict("not_pending", "This order is already paid.");
      settlePendingFor({ orderId: id }, method);
    }

    if (action === "fulfil") {
      if (row.status === "fulfilled") throw conflict("already_fulfilled", "This order was already handed over.");
      if (row.payment_status !== "paid") {
        throw conflict("payment_required", "Collect payment before handing the item over.");
      }
      run("UPDATE orders SET status = 'fulfilled' WHERE id = ?", id);
    }

    if (action === "cancel") {
      if (row.status === "fulfilled") {
        throw conflict("already_fulfilled", "This order was already handed over and cannot be cancelled.");
      }
      run("UPDATE orders SET status = 'cancelled' WHERE id = ?", id);
      run("UPDATE product_variants SET stock = stock + ? WHERE id = ?", row.quantity, row.variant_id);
      if (row.payment_status === "pending") {
        voidPendingFor({ orderId: id }, "Order cancelled");
      } else {
        refundDueCents = row.total_cents;
        recordTransaction({
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
    return { order: toOrder(getOrderRow(id)), refundDueCents };
  });
}
