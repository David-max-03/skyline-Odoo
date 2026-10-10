"use client";

import { useParams } from "next/navigation";
import { Check, ShoppingCart } from "lucide-react";
import { useState } from "react";
import { Money } from "@/components/domain";
import { Availability, ProductPhoto, QuantityStepper } from "@/components/shop-ui";
import { Button, Card, ErrorState, LinkButton, Notice, PageHeader, Skeleton, cn } from "@/components/ui";
import { useApi } from "@/lib/api-client";
import { cart } from "@/lib/cart";
import { PRODUCT_CATEGORY_LABELS, type PublicProduct } from "@/lib/contracts";

export default function ProductPage() {
  const { id } = useParams<{ id: string }>();
  const { data: product, error, reload } = useApi<PublicProduct>(`/api/public/products/${id}`);
  const [photo, setPhoto] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState<string | null>(null);

  if (error && !product) {
    return (
      <>
        <PageHeader title="Product" back={{ href: "/shop", label: "Shop" }} />
        <Card>
          <ErrorState message={error.status === 404 ? "This product is not on sale." : error.message} onRetry={reload} />
        </Card>
      </>
    );
  }
  if (!product) {
    return (
      <div role="status" aria-label="Loading product" className="grid gap-6 md:grid-cols-2">
        <Skeleton className="aspect-square" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  const inStock = product.variants.filter((v) => v.inStock);
  // With one size on offer there is nothing to choose.
  const variantId = picked ?? (inStock.length === 1 ? inStock[0].id : null);
  const chosen = product.variants.find((v) => v.id === variantId && v.inStock) ?? null;
  const single = product.variants.length === 1;
  const amount = chosen ? Math.min(quantity, chosen.stock) : quantity;

  function add() {
    if (!chosen || !product) return;
    cart.add({
      variantId: chosen.id,
      productId: product.id,
      name: product.name,
      size: chosen.size,
      priceCents: product.priceCents,
      imageUrl: product.images[0]?.url ?? null,
      quantity: amount,
    });
    setAdded(`${amount} × ${product.name}${single ? "" : ` (${chosen.size})`}`);
  }

  return (
    <>
      <PageHeader back={{ href: "/shop", label: "Shop" }} title={product.name} />
      <div className="grid gap-6 md:grid-cols-2 md:gap-8">
        <div>
          <ProductPhoto url={product.images[photo]?.url ?? product.images[0]?.url} name={product.name} className="aspect-square w-full rounded-card border border-line" />
          {product.images.length > 1 && (
            <ul className="mt-3 flex gap-2">
              {product.images.map((image, i) => (
                <li key={image.id}>
                  <button
                    type="button"
                    onClick={() => setPhoto(i)}
                    aria-label={`Photo ${i + 1} of ${product.images.length}`}
                    aria-pressed={photo === i}
                    className={cn("block size-16 overflow-hidden rounded-control border-2", photo === i ? "border-brand" : "border-line hover:border-line-strong")}
                  >
                    <ProductPhoto url={image.url} name="" className="size-full" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{PRODUCT_CATEGORY_LABELS[product.category]}</p>
          <p className="mt-2 font-display text-3xl font-bold text-ink">
            <Money cents={product.priceCents} />
          </p>
          {product.memberPriceCents < product.priceCents && (
            <p className="text-sm text-ok">
              Members pay <Money cents={product.memberPriceCents} />. The member price is applied at checkout.
            </p>
          )}
          <div className="mt-3">
            <Availability product={product} />
          </div>
          {product.description && <p className="mt-4 whitespace-pre-line text-sm leading-relaxed">{product.description}</p>}

          {!single && (
            <fieldset className="mt-6">
              <legend className="mb-2 text-sm font-medium text-ink">Size</legend>
              <div className="flex flex-wrap gap-2">
                {product.variants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    disabled={!v.inStock}
                    aria-pressed={variantId === v.id}
                    onClick={() => {
                      setPicked(v.id);
                      setAdded(null);
                    }}
                    className={cn(
                      "h-11 min-w-12 rounded-control border px-3.5 text-sm font-medium transition-colors",
                      variantId === v.id ? "border-brand bg-brand text-on-brand" : "border-line-strong bg-surface text-ink hover:border-brand",
                      !v.inStock && "border-line text-subtle line-through hover:border-line",
                    )}
                  >
                    {v.size}
                    {!v.inStock && <span className="sr-only"> (sold out)</span>}
                  </button>
                ))}
              </div>
            </fieldset>
          )}

          {inStock.length > 0 && (
            <div className="mt-6">
              <p className="mb-2 text-sm font-medium text-ink">Quantity</p>
              <div className="flex flex-wrap items-center gap-3">
                <QuantityStepper value={amount} max={chosen?.stock} onChange={setQuantity} label="Quantity" />
                {chosen && <span className="text-sm text-muted">{chosen.stock <= 5 ? `Only ${chosen.stock} left in this size` : `${chosen.stock} in stock`}</span>}
              </div>
            </div>
          )}

          <Button size="lg" className="mt-6 w-full sm:w-auto" icon={ShoppingCart} disabled={!chosen} onClick={add}>
            {inStock.length === 0 ? "Sold out" : chosen ? "Add to cart" : "Choose a size"}
          </Button>

          <div aria-live="polite">
            {added && (
              <Notice tone="ok" icon={Check} title={`${added} added to your cart`} className="mt-4">
                <div className="mt-2 flex flex-wrap gap-2">
                  <LinkButton href="/shop/cart" size="sm">
                    Go to cart
                  </LinkButton>
                  <LinkButton href="/shop" size="sm" variant="secondary">
                    Keep shopping
                  </LinkButton>
                </div>
              </Notice>
            )}
          </div>
          <p className="mt-4 text-[0.8125rem] text-muted">No payment is taken on this site. You pay the committee when you collect your order.</p>
        </div>
      </div>
    </>
  );
}
