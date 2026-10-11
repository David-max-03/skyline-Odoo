"use client";

import { Banknote, Check, ExternalLink, Plus, Shirt, ShoppingBag } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Money, OrderStatusBadge } from "@/components/domain";
import { ConfirmDialog, Dialog, DialogActions, useToast } from "@/components/overlay";
import { useCan } from "@/components/session";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  FormError,
  LinkButton,
  LoadingBlock,
  PageHeader,
  Table,
  Td,
  SelectField,
  TextAreaField,
  TextField,
  Th,
  cn,
} from "@/components/ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import { OrderPaymentsPanel } from "@/components/order-payments-panel";
import { ProductEditor } from "@/components/product-editor";
import { ProductPhoto } from "@/components/shop-ui";
import { PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS, SETTINGS, type Order, type Product } from "@/lib/contracts";
import { formatShortDateTime } from "@/lib/dates";
import { CURRENCY, parseMoney } from "@/lib/money";

const SYMBOL =
  new Intl.NumberFormat("en", { style: "currency", currency: CURRENCY }).formatToParts(0).find((p) => p.type === "currency")
    ?.value ?? "";

export default function MerchPage() {
  const toast = useToast();
  const canManage = useCan("manageMerch");
  const canRefund = useCan("processRefunds");
  const products = useApi<Product[]>("/api/products");
  const orders = useApi<Order[]>("/api/orders");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = products.data?.find((p) => p.id === editingId) ?? null;
  const [cancelling, setCancelling] = useState<Order | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reloadAll = () => {
    products.reload();
    orders.reload();
  };

  async function orderAction(order: Order, action: "pay" | "fulfil" | "cancel") {
    setBusy(`${action}-${order.id}`);
    try {
      const result = await api<{ refundDueCents: number }>(`/api/orders/${order.id}`, { method: "POST", body: { action, method: "cash" } });
      toast.success(
        action === "pay"
          ? `Payment recorded for order ${order.code}.`
          : action === "fulfil"
            ? `Order ${order.code} handed over.`
            : result.refundDueCents > 0
              ? `Order cancelled and stock returned. A refund is now owed to ${order.buyerName}.`
              : "Order cancelled and stock returned.",
      );
      setCancelling(null);
      reloadAll();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function saveStock(product: Product, variantId: string, stock: number) {
    try {
      await api(`/api/products/${product.id}`, { method: "POST", body: { variantId, stock } });
      toast.success("Stock updated.");
      products.reload();
    } catch (error) {
      toast.error(errorMessage(error));
      products.reload();
    }
  }

  return (
    <>
      <PageHeader
        title="Merchandise"
        description="What is in stock in each size, and every order from the public shop. Stock goes down when an order is placed and comes back if it is cancelled."
        actions={
          <>
            <LinkButton href="/shop" target="_blank" variant="secondary" icon={ExternalLink}>
              Public shop
            </LinkButton>
            {canManage && (
              <Button icon={Plus} onClick={() => setAdding(true)}>
                Add product
              </Button>
            )}
          </>
        }
      />

      {canManage && <OrderPaymentsPanel />}

      {products.error && !products.data ? (
        <Card>
          <ErrorState message={products.error.message} onRetry={products.reload} />
        </Card>
      ) : !products.data ? (
        <Card>
          <LoadingBlock label="Loading products" />
        </Card>
      ) : products.data.length === 0 ? (
        <Card>
          <EmptyState icon={Shirt} title="No products yet" description="Add a hoodie or T-shirt with the sizes you have in stock." />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {products.data.map((product) => (
            <Card key={product.id}>
              <CardHeader
                title={
                  <span className="flex items-center gap-3">
                    <ProductPhoto url={product.images[0]?.url} name="" className="size-11 shrink-0 rounded-control border border-line" />
                    <span className="min-w-0">
                      {product.name}
                      <span className="block text-xs font-normal text-muted">{PRODUCT_CATEGORY_LABELS[product.category]}</span>
                    </span>
                  </span>
                }
                description={
                  <>
                    <Money cents={product.priceCents} /> · members <Money cents={product.memberPriceCents} /> · {product.unitsSold} sold
                  </>
                }
                action={
                  <>
                    {!product.active && <Badge>Not on sale</Badge>}
                    {canManage && (
                      <Button size="sm" variant="secondary" onClick={() => setEditingId(product.id)}>
                        Edit
                      </Button>
                    )}
                  </>
                }
              />
              <ul className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
                {product.variants.map((v) => (
                  <li key={v.id}>
                    <StockCell
                      key={`${v.id}-${v.stock}`}
                      size={v.size}
                      stock={v.stock}
                      editable={canManage}
                      onSave={(stock) => saveStock(product, v.id, stock)}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-6">
        <CardHeader title="Orders" description="Collect payment, then hand the item over." />
        {orders.error && !orders.data ? (
          <ErrorState message={orders.error.message} onRetry={orders.reload} />
        ) : !orders.data ? (
          <LoadingBlock label="Loading orders" />
        ) : orders.data.length === 0 ? (
          <EmptyState icon={ShoppingBag} title="No orders yet" description="Orders placed in the public shop appear here." />
        ) : (
          <Table stack>
            <thead>
              <tr>
                <Th>Order</Th>
                <Th>Buyer</Th>
                <Th>Item</Th>
                <Th align="right">Total</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {orders.data.map((o) => (
                <tr key={o.id} className={o.status === "cancelled" ? "text-subtle" : "transition-colors hover:bg-sunken/50"}>
                  <Td label="Order">
                    <div>
                      <div className="font-mono text-[0.8125rem] text-ink">{o.code}</div>
                      <div className="text-xs text-muted">{formatShortDateTime(o.createdAt)}</div>
                    </div>
                  </Td>
                  <Td layout="lead" className="max-sm:order-first">
                    <div className="font-medium text-ink">{o.buyerName}</div>
                    <div className="text-[0.8125rem] text-muted">{o.memberNo ? `Member ${o.memberNo}` : o.buyerEmail}</div>
                  </Td>
                  <Td label="Item">
                    <span>
                      {o.quantity} × {o.productName} <span className="text-muted">({o.size})</span>
                    </span>
                  </Td>
                  <Td label="Total" align="right">
                    <Money cents={o.totalCents} className="font-medium text-ink" />
                  </Td>
                  <Td label="Status">
                    <div className="flex flex-wrap gap-1">
                      {o.status !== "cancelled" && (
                        <Badge tone={o.paymentStatus === "paid" ? "ok" : "warn"}>{o.paymentStatus === "paid" ? "Paid" : "Unpaid"}</Badge>
                      )}
                      <OrderStatusBadge status={o.status} />
                    </div>
                  </Td>
                  <Td layout="actions">
                    {canManage && o.status === "placed" && (
                      <div className="flex justify-end gap-1">
                        {o.paymentStatus === "pending" ? (
                          <Button size="sm" variant="secondary" icon={Banknote} loading={busy === `pay-${o.id}`} onClick={() => orderAction(o, "pay")}>
                            Mark paid
                          </Button>
                        ) : (
                          <Button size="sm" variant="secondary" icon={Check} loading={busy === `fulfil-${o.id}`} onClick={() => orderAction(o, "fulfil")}>
                            Hand over
                          </Button>
                        )}
                        {(o.paymentStatus === "pending" || canRefund) && (
                          <Button size="sm" variant="ghost" onClick={() => setCancelling(o)}>
                            Cancel
                          </Button>
                        )}
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Dialog open={editing !== null} onClose={() => setEditingId(null)} title="Edit product" description={editing?.name} size="lg">
        {editing && <ProductEditor key={editing.id} product={editing} onChanged={() => products.reload()} onClose={() => setEditingId(null)} />}
      </Dialog>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add a product">
        {adding && (
          <ProductForm
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              toast.success("Product added to the shop.");
              products.reload();
            }}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        onConfirm={() => cancelling && orderAction(cancelling, "cancel")}
        title="Cancel this order?"
        confirmLabel="Cancel order"
        danger
        loading={busy === `cancel-${cancelling?.id}`}
      >
        {cancelling && (
          <p>
            {cancelling.quantity} × {cancelling.productName} ({cancelling.size}) goes back into stock.
            {cancelling.paymentStatus === "paid" && ` It was paid, so a refund will be listed for ${cancelling.buyerName}.`}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

function StockCell({
  size,
  stock,
  editable,
  onSave,
}: {
  size: string;
  stock: number;
  editable: boolean;
  onSave: (stock: number) => void;
}) {
  const [value, setValue] = useState(String(stock));
  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(parsed) && parsed >= 0;
  const changed = valid && parsed !== stock;
  const low = stock <= SETTINGS.lowStockThreshold;

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (changed) onSave(parsed);
      }}
      className={cn("rounded-control border p-3", stock === 0 ? "border-bad/40 bg-bad-soft/50" : low ? "border-warn/30 bg-warn-soft/50" : "border-line")}
    >
      <div className="flex items-baseline justify-between">
        <span className="font-display text-base font-bold text-ink">{size}</span>
        {stock === 0 ? <Badge tone="bad">Sold out</Badge> : low && <Badge tone="warn">Low</Badge>}
      </div>
      {editable ? (
        <div className="mt-2 flex gap-1.5">
          <input
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`Stock for size ${size}`}
            aria-invalid={!valid || undefined}
            className="num h-9 w-full min-w-0 rounded-control border border-line-strong bg-surface px-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 aria-[invalid=true]:border-bad"
          />
          {changed && (
            <Button type="submit" size="sm">
              Save
            </Button>
          )}
        </div>
      ) : (
        <p className="num mt-1 text-sm text-body">{stock} in stock</p>
      )}
    </form>
  );
}

function ProductForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [values, setValues] = useState({ name: "", category: "apparel", description: "", price: "", memberPrice: "" });
  const [sizes, setSizes] = useState([
    { size: "S", stock: "0" },
    { size: "M", stock: "0" },
    { size: "L", stock: "0" },
    { size: "XL", stock: "0" },
  ]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const priceCents = parseMoney(values.price);
    const memberPriceCents = values.memberPrice.trim() ? parseMoney(values.memberPrice) : priceCents;
    const local: Record<string, string> = {};
    if (!priceCents) local.priceCents = "Enter a price greater than zero";
    if (!memberPriceCents) local.memberPriceCents = "Enter a price greater than zero";
    const variants = sizes.filter((s) => s.size.trim()).map((s) => ({ size: s.size.trim(), stock: Number(s.stock) }));
    if (variants.some((v) => !Number.isInteger(v.stock) || v.stock < 0)) local.variants = "Stock must be a whole number, zero or more";
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length) return;

    setSaving(true);
    try {
      await api("/api/products", {
        method: "POST",
        body: { name: values.name, category: values.category, description: values.description, priceCents, memberPriceCents, active: true, variants },
      });
      onSaved();
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <FormError message={formError} />
      <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
        <TextField label="Product name" value={values.name} onChange={set("name")} error={errors.name} placeholder="Skyline Hoodie" required autoFocus />
        <SelectField label="Category" value={values.category} onChange={set("category")} error={errors.category}>
          {PRODUCT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {PRODUCT_CATEGORY_LABELS[c]}
            </option>
          ))}
        </SelectField>
      </div>
      <p className="-mt-2 text-[0.8125rem] text-muted">Add photos after saving, with Edit on the product card.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Price" prefix={SYMBOL} inputMode="decimal" value={values.price} onChange={set("price")} error={errors.priceCents} required />
        <TextField label="Member price" prefix={SYMBOL} inputMode="decimal" value={values.memberPrice} onChange={set("memberPrice")} error={errors.memberPriceCents} optional hint="Blank = same as price" />
      </div>
      <TextAreaField label="Description" value={values.description} onChange={set("description")} error={errors.description} optional />
      <fieldset>
        <legend className="mb-1.5 text-[0.8125rem] font-medium text-ink">Sizes and opening stock</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {sizes.map((s, i) => (
            <div key={i} className="flex gap-1.5">
              <input
                aria-label={`Size ${i + 1} name`}
                value={s.size}
                onChange={(e) => setSizes((list) => list.map((x, j) => (j === i ? { ...x, size: e.target.value } : x)))}
                className="h-10 w-14 rounded-control border border-line-strong bg-surface px-2 text-center text-sm font-semibold text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
              />
              <input
                aria-label={`Stock for size ${s.size || i + 1}`}
                inputMode="numeric"
                value={s.stock}
                onChange={(e) => setSizes((list) => list.map((x, j) => (j === i ? { ...x, stock: e.target.value } : x)))}
                className="num h-10 w-full min-w-0 rounded-control border border-line-strong bg-surface px-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
              />
            </div>
          ))}
        </div>
        {errors.variants ? (
          <p role="alert" className="mt-1.5 text-[0.8125rem] text-bad">{errors.variants}</p>
        ) : (
          <p className="mt-1.5 text-[0.8125rem] text-muted">Clear a size name to leave it out.</p>
        )}
      </fieldset>
      <DialogActions>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          Add product
        </Button>
      </DialogActions>
    </form>
  );
}
