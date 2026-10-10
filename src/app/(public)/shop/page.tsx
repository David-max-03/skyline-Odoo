"use client";

import { CircleCheck, Shirt } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Money } from "@/components/domain";
import { Dialog, DialogActions } from "@/components/overlay";
import { Button, Card, EmptyState, ErrorState, FormError, Notice, PageHeader, SelectField, Skeleton, TextField, cn } from "@/components/ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import { SETTINGS, type PublicOrder, type PublicProduct } from "@/lib/contracts";

export default function ShopPage() {
  const { data, error, reload } = useApi<PublicProduct[]>("/api/public/products");
  const [ordering, setOrdering] = useState<{ product: PublicProduct; variantId: string } | null>(null);
  const [placed, setPlaced] = useState<PublicOrder | null>(null);

  return (
    <>
      <PageHeader title="Shop" description="Club merchandise. Order your size here and pay a committee member when you collect it." />

      {placed && (
        <Notice tone="ok" icon={CircleCheck} title={`Order ${placed.code} placed`} className="mb-5">
          {placed.quantity} × {placed.productName} ({placed.size}) is reserved for you. Bring <Money cents={placed.totalCents} className="font-semibold" />
          {placed.isMember && " (member price)"} and this order code when you collect it. No payment was taken on this site.
        </Notice>
      )}

      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : !data ? (
        <div className="grid gap-4 sm:grid-cols-2" role="status" aria-label="Loading products">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      ) : data.length === 0 ? (
        <Card>
          <EmptyState icon={Shirt} title="Nothing on sale right now" />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data.map((product) => (
            <Card key={product.id} className="flex flex-col p-5">
              <h2 className="text-lg font-bold">{product.name}</h2>
              {product.description && <p className="mt-1 text-sm text-muted">{product.description}</p>}
              <p className="mt-3 font-display text-xl font-bold text-ink">
                <Money cents={product.priceCents} />
                {product.memberPriceCents < product.priceCents && (
                  <span className="ml-2 font-sans text-sm font-normal text-muted">
                    members <Money cents={product.memberPriceCents} />
                  </span>
                )}
              </p>
              <p className="mb-2 mt-4 text-[0.8125rem] font-medium text-ink">Choose a size</p>
              <ul className="flex flex-wrap gap-2">
                {product.variants.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      disabled={!v.inStock}
                      onClick={() => {
                        setPlaced(null);
                        setOrdering({ product, variantId: v.id });
                      }}
                      className={cn(
                        "flex min-w-16 flex-col items-center rounded-control border px-3 py-2 text-sm transition-colors",
                        v.inStock
                          ? "border-line-strong bg-surface text-ink hover:border-brand hover:bg-brand-soft"
                          : "border-line bg-sunken text-subtle",
                      )}
                    >
                      <span className="font-semibold">{v.size}</span>
                      <span className="text-xs text-muted">
                        {!v.inStock ? "Sold out" : v.stock <= SETTINGS.lowStockThreshold ? `${v.stock} left` : "In stock"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={ordering !== null}
        onClose={() => setOrdering(null)}
        title={ordering ? `Order ${ordering.product.name}` : "Order"}
        description="Your size is reserved as soon as you place the order."
      >
        {ordering && (
          <OrderForm
            key={ordering.variantId}
            product={ordering.product}
            variantId={ordering.variantId}
            onCancel={() => setOrdering(null)}
            onPlaced={(order) => {
              setOrdering(null);
              setPlaced(order);
              reload();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            onStockChanged={reload}
          />
        )}
      </Dialog>
    </>
  );
}

function OrderForm({
  product,
  variantId,
  onPlaced,
  onCancel,
  onStockChanged,
}: {
  product: PublicProduct;
  variantId: string;
  onPlaced: (order: PublicOrder) => void;
  onCancel: () => void;
  onStockChanged: () => void;
}) {
  const variant = product.variants.find((v) => v.id === variantId)!;
  const [values, setValues] = useState({ quantity: "1", name: "", email: "", memberNo: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));
  const quantity = Number(values.quantity);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setWorking(true);
    setFormError(null);
    setErrors({});
    try {
      const order = await api<PublicOrder>("/api/public/orders", {
        method: "POST",
        body: { productId: product.id, variantId, quantity, name: values.name, email: values.email, memberNo: values.memberNo || null },
      });
      onPlaced(order);
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
      onStockChanged();
      setWorking(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <FormError message={formError} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Size" value={variant.size} readOnly disabled />
        <SelectField label="Quantity" value={values.quantity} onChange={set("quantity")} error={errors.quantity}>
          {Array.from({ length: Math.min(10, variant.stock) }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </SelectField>
      </div>
      <TextField label="Full name" autoComplete="name" value={values.name} onChange={set("name")} error={errors.name} required />
      <TextField label="Email" type="email" autoComplete="email" value={values.email} onChange={set("email")} error={errors.email} required />
      {product.memberPriceCents < product.priceCents && (
        <TextField
          label="Member number"
          value={values.memberNo}
          onChange={set("memberNo")}
          error={errors.memberNo}
          placeholder="SKY-M-0001"
          optional
          hint="With the email on your membership, you pay the member price."
        />
      )}
      <p className="rounded-control bg-sunken px-3 py-2.5 text-sm">
        Standard total: <Money cents={product.priceCents * quantity} className="font-semibold text-ink" />
        {product.memberPriceCents < product.priceCents && (
          <>
            {" "}
            · members: <Money cents={product.memberPriceCents * quantity} className="font-semibold text-ink" />
          </>
        )}
        <span className="block text-[0.8125rem] text-muted">Pay when you collect. Nothing is charged here.</span>
      </p>
      <DialogActions>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={working}>
          Place order
        </Button>
      </DialogActions>
    </form>
  );
}
