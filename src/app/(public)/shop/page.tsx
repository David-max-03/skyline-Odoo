"use client";

import Link from "next/link";
import { Search, ShoppingBag, ShoppingCart } from "lucide-react";
import { useMemo, useState } from "react";
import { Money } from "@/components/domain";
import { useToast } from "@/components/overlay";
import { Availability, ProductPhoto } from "@/components/shop-ui";
import { Button, Card, EmptyState, ErrorState, Skeleton, cn } from "@/components/ui";
import { useApi } from "@/lib/api-client";
import { cart } from "@/lib/cart";
import { PRODUCT_CATEGORY_LABELS, type ProductCategory, type PublicProduct } from "@/lib/contracts";

function ProductCard({ product }: { product: PublicProduct }) {
  const toast = useToast();
  const inStock = product.variants.filter((v) => v.inStock);
  // One size on offer is chosen for you; otherwise the shopper picks.
  const [variantId, setVariantId] = useState(inStock.length === 1 ? inStock[0].id : "");
  const chosen = product.variants.find((v) => v.id === variantId && v.inStock);
  const single = product.variants.length === 1;
  const href = `/shop/${product.id}`;

  function add() {
    if (!chosen) return;
    cart.add({
      variantId: chosen.id,
      productId: product.id,
      name: product.name,
      size: chosen.size,
      priceCents: product.priceCents,
      imageUrl: product.images[0]?.url ?? null,
      quantity: 1,
    });
    toast.success(`${product.name}${single ? "" : ` (${chosen.size})`} added to your cart.`);
  }

  return (
    <li className="flex flex-col overflow-hidden rounded-card border border-line bg-surface shadow-card">
      <Link href={href} aria-label={product.name} tabIndex={-1}>
        <ProductPhoto url={product.images[0]?.url} name={product.name} className="aspect-square w-full" />
      </Link>
      <div className="flex flex-1 flex-col p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{PRODUCT_CATEGORY_LABELS[product.category]}</p>
        <h2 className="mt-0.5 text-[0.9375rem] font-semibold leading-snug">
          <Link href={href} className="hover:text-brand hover:underline">
            {product.name}
          </Link>
        </h2>
        <p className="mt-1.5 font-display text-xl font-bold text-ink">
          <Money cents={product.priceCents} />
        </p>
        {product.memberPriceCents < product.priceCents && (
          <p className="text-[0.8125rem] text-ok">
            Members <Money cents={product.memberPriceCents} />
          </p>
        )}
        <div className="mt-2">
          <Availability product={product} />
        </div>

        {!single && inStock.length > 0 && (
          <fieldset className="mt-3">
            <legend className="mb-1.5 text-[0.8125rem] font-medium text-ink">Size</legend>
            <div className="flex flex-wrap gap-1.5">
              {product.variants.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  disabled={!v.inStock}
                  aria-pressed={variantId === v.id}
                  onClick={() => setVariantId(v.id)}
                  className={cn(
                    "h-9 min-w-9 rounded-control border px-2.5 text-[0.8125rem] font-medium transition-colors",
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

        <div className="mt-auto pt-4">
          <Button className="w-full" icon={ShoppingCart} disabled={inStock.length === 0 || !chosen} onClick={add}>
            {inStock.length === 0 ? "Sold out" : chosen ? "Add to cart" : "Choose a size"}
          </Button>
        </div>
      </div>
    </li>
  );
}

export default function ShopPage() {
  const { data, error, reload } = useApi<PublicProduct[]>("/api/public/products");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<ProductCategory | "all">("all");

  const categories = useMemo(() => [...new Set((data ?? []).map((p) => p.category))], [data]);
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data ?? []).filter(
      (p) => (category === "all" || p.category === category) && (!term || `${p.name} ${p.description}`.toLowerCase().includes(term)),
    );
  }, [data, search, category]);

  const chip = (active: boolean) =>
    cn(
      "h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium transition-colors",
      active ? "border-brand bg-brand text-on-brand" : "border-line-strong bg-surface text-ink hover:border-brand",
    );

  return (
    <>
      <section className="rounded-card bg-night px-5 py-6 sm:px-8 sm:py-8">
        <h1 className="text-2xl font-extrabold !text-white sm:text-3xl">Skyline shop</h1>
        <p className="mt-1 text-sm text-on-night-muted">Club merchandise. Order here, pay and collect from the committee. Members pay less.</p>
        <form role="search" onSubmit={(e) => e.preventDefault()} className="relative mt-5 max-w-2xl">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search hoodies, tees, stickers…"
            aria-label="Search the shop"
            className="h-12 w-full rounded-control border-0 bg-surface pl-12 pr-4 text-base text-ink placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </form>
      </section>

      {categories.length > 1 && (
        <nav aria-label="Categories" className="no-scrollbar mt-5 flex gap-2 overflow-x-auto">
          <button type="button" aria-pressed={category === "all"} onClick={() => setCategory("all")} className={chip(category === "all")}>
            Everything
          </button>
          {categories.map((c) => (
            <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)} className={chip(category === c)}>
              {PRODUCT_CATEGORY_LABELS[c]}
            </button>
          ))}
        </nav>
      )}

      <div className="mt-5">
        {error && !data ? (
          <Card>
            <ErrorState message={error.message} onRetry={reload} />
          </Card>
        ) : !data ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4" role="status" aria-label="Loading products">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="aspect-[3/5]" />
            ))}
          </div>
        ) : data.length === 0 ? (
          <Card>
            <EmptyState icon={ShoppingBag} title="The shop is empty right now" description="New merchandise is announced on the news board." />
          </Card>
        ) : visible.length === 0 ? (
          <Card>
            <EmptyState
              icon={Search}
              title="Nothing matches"
              description="Try a different word, or look at everything."
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch("");
                    setCategory("all");
                  }}
                >
                  Show everything
                </Button>
              }
            />
          </Card>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted" aria-live="polite">
              {visible.length} {visible.length === 1 ? "product" : "products"}
            </p>
            <ul className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
              {visible.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
