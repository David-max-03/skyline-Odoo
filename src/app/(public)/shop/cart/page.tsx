"use client";

import Link from "next/link";
import { CircleCheck, ShoppingCart, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Money } from "@/components/domain";
import { ProductPhoto, QuantityStepper } from "@/components/shop-ui";
import { Badge, Button, Card, EmptyState, FormError, LinkButton, Notice, PageHeader, TextField } from "@/components/ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import { cart, useCart } from "@/lib/cart";
import type { PublicProduct, SessionUser, ShopOrder } from "@/lib/contracts";

function Confirmation({ order, isMemberAccount }: { order: ShopOrder; isMemberAccount: boolean }) {
  return (
    <Card className="p-5">
      <Notice tone="ok" icon={CircleCheck} title="Order placed. Your items are reserved.">
        It is not paid yet. Pay the committee when you collect it; they will mark it paid.
      </Notice>
      <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted">Order number</dt>
          <dd className="font-mono text-xl font-bold text-ink">{order.code}</dd>
        </div>
        <div>
          <dt className="text-muted">Total to pay</dt>
          <dd className="font-display text-xl font-bold text-ink">
            <Money cents={order.totalCents} />
          </dd>
        </div>
        <div>
          <dt className="text-muted">Payment</dt>
          <dd className="mt-0.5 flex flex-wrap gap-1.5">
            <Badge tone="warn">Unpaid</Badge>
            {order.isMember && <Badge tone="ok">Member price</Badge>}
          </dd>
        </div>
      </dl>
      <ul className="mt-5 divide-y divide-line rounded-control border border-line text-sm">
        {order.lines.map((line) => (
          <li key={line.orderId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
            <span className="text-ink">
              {line.quantity} × {line.productName} <span className="text-muted">({line.size})</span>
            </span>
            <Money cents={line.totalCents} className="font-medium text-ink" />
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-muted">Write the order number down and quote it when you collect.</p>
      <div className="mt-5 flex flex-wrap gap-2">
        {isMemberAccount && <LinkButton href="/member/orders">See my orders</LinkButton>}
        <LinkButton href="/shop" variant="secondary">
          Back to the shop
        </LinkButton>
      </div>
    </Card>
  );
}

export default function CartPage() {
  const lines = useCart();
  const me = useApi<{ user: SessionUser | null }>("/api/auth/me");
  const products = useApi<PublicProduct[]>("/api/public/products");
  const [values, setValues] = useState({ name: "", email: "", memberNo: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [placed, setPlaced] = useState<ShopOrder | null>(null);

  const member = me.data?.user?.role === "member" ? me.data.user : null;
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  /** Each cart line with the product's current price and stock, when the catalogue has loaded. */
  const rows = lines.map((line) => {
    const product = products.data?.find((p) => p.id === line.productId);
    const variant = product?.variants.find((v) => v.id === line.variantId);
    const gone = !!products.data && (!product || !variant);
    return {
      line,
      gone,
      stock: variant?.stock ?? null,
      priceCents: product?.priceCents ?? line.priceCents,
      short: variant ? variant.stock < line.quantity : false,
    };
  });
  const subtotal = rows.filter((r) => !r.gone).reduce((sum, r) => sum + r.priceCents * r.line.quantity, 0);
  const blocked = rows.some((r) => r.gone || r.short);

  async function placeOrder(e: FormEvent) {
    e.preventDefault();
    setWorking(true);
    setFormError(null);
    setErrors({});
    try {
      // Only sizes and quantities are sent; the server prices the order.
      const items = lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
      const order = member
        ? await api<ShopOrder>("/api/me/checkout", { method: "POST", body: { items } })
        : await api<ShopOrder>("/api/public/checkout", { method: "POST", body: { items, ...values, memberNo: values.memberNo || null } });
      cart.clear();
      setPlaced(order);
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
      products.reload(); // stock may have changed
    } finally {
      setWorking(false);
    }
  }

  if (placed) {
    return (
      <>
        <PageHeader title="Thank you" />
        <Confirmation order={placed} isMemberAccount={member !== null} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Your cart" back={{ href: "/shop", label: "Shop" }} />
      {lines.length === 0 ? (
        <Card>
          <EmptyState
            icon={ShoppingCart}
            title="Your cart is empty"
            description="Add something from the shop and it will wait here."
            action={<LinkButton href="/shop">Browse the shop</LinkButton>}
          />
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <Card>
            <ul className="divide-y divide-line">
              {rows.map(({ line, gone, short, stock, priceCents }) => (
                <li key={line.variantId} className="flex gap-4 p-4">
                  <Link href={`/shop/${line.productId}`} className="shrink-0" tabIndex={-1} aria-hidden>
                    <ProductPhoto url={line.imageUrl} name="" className="size-20 rounded-control border border-line" />
                  </Link>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                      <div className="min-w-0">
                        <Link href={`/shop/${line.productId}`} className="font-medium text-ink hover:text-brand hover:underline">
                          {line.name}
                        </Link>
                        <p className="text-[0.8125rem] text-muted">
                          Size {line.size} · <Money cents={priceCents} /> each
                        </p>
                      </div>
                      <Money cents={priceCents * line.quantity} className="font-display text-lg font-bold text-ink" />
                    </div>
                    {gone ? (
                      <p className="mt-1 text-[0.8125rem] font-medium text-bad">No longer for sale. Remove it to continue.</p>
                    ) : short ? (
                      <p className="mt-1 text-[0.8125rem] font-medium text-bad">
                        {stock === 0 ? "Sold out. Remove it to continue." : `Only ${stock} left. Lower the quantity to continue.`}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {!gone && (
                        <QuantityStepper
                          value={line.quantity}
                          max={stock && stock > 0 ? Math.max(stock, 1) : undefined}
                          onChange={(q) => cart.setQuantity(line.variantId, q)}
                          label={`Quantity of ${line.name}, size ${line.size}`}
                        />
                      )}
                      <Button variant="ghost" size="sm" icon={Trash2} onClick={() => cart.remove(line.variantId)}>
                        Remove
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="h-fit p-5">
            <h2 className="text-lg font-bold">Checkout</h2>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">
                  Items ({lines.reduce((sum, l) => sum + l.quantity, 0)})
                </dt>
                <dd>
                  <Money cents={subtotal} />
                </dd>
              </div>
              <div className="flex justify-between border-t border-line pt-2 text-base font-semibold text-ink">
                <dt>Order total</dt>
                <dd>
                  <Money cents={subtotal} />
                </dd>
              </div>
            </dl>
            <p className="mt-1.5 text-[0.8125rem] text-muted">
              At standard prices. {member ? "If your membership is active, the member price is applied when you place the order." : "Members pay less: enter your member number below."}
            </p>

            <form onSubmit={placeOrder} noValidate className="mt-4 space-y-4">
              <FormError message={formError} />
              {member ? (
                <p className="rounded-control bg-sunken px-3 py-2.5 text-sm">
                  Ordering as <span className="font-medium text-ink">{member.name}</span> <span className="font-mono text-muted">{member.memberNo}</span>
                </p>
              ) : (
                <>
                  <TextField label="Full name" autoComplete="name" value={values.name} onChange={set("name")} error={errors.name} required />
                  <TextField label="Email" type="email" autoComplete="email" value={values.email} onChange={set("email")} error={errors.email} required />
                  <TextField
                    label="Member number"
                    value={values.memberNo}
                    onChange={set("memberNo")}
                    error={errors.memberNo}
                    placeholder="SKY-M-0001"
                    hint="With the email on your membership, for the member price."
                    optional
                  />
                  <p className="text-[0.8125rem] text-muted">
                    Have a member account?{" "}
                    <Link href="/login?next=/member" className="font-medium text-brand hover:underline">
                      Sign in
                    </Link>{" "}
                    to keep your orders in one place.
                  </p>
                </>
              )}
              {(errors.variantId || errors.quantity || errors.items) && (
                <p role="alert" className="text-[0.8125rem] text-bad">
                  {errors.variantId ?? errors.quantity ?? errors.items}
                </p>
              )}
              <Button type="submit" size="lg" className="w-full" loading={working} disabled={blocked}>
                Place order
              </Button>
              <p className="text-[0.8125rem] text-muted">
                No payment is taken on this site. Your items are reserved now and you pay the committee when you collect them.
              </p>
            </form>
          </Card>
        </div>
      )}
    </>
  );
}
