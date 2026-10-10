"use client";

import Link from "next/link";
import { Minus, Plus, Shirt, ShoppingCart } from "lucide-react";
import { useCart } from "@/lib/cart";
import { MAX_QUANTITY_PER_LINE, type PublicProduct } from "@/lib/contracts";
import { Badge, cn } from "./ui";

/** A product photo, or a plain tile when the committee has not uploaded one. */
export function ProductPhoto({ url, name, className }: { url: string | null | undefined; name: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center overflow-hidden bg-sunken", className)}>
      {url ? (
        // Served by our own API under a random id; next/image would need a loader for it.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={name} loading="lazy" className="size-full object-cover" />
      ) : (
        <Shirt className="size-1/4 text-line-strong" aria-hidden />
      )}
    </div>
  );
}

/** What can be bought right now, in words. */
export function Availability({ product }: { product: PublicProduct }) {
  const total = product.variants.reduce((sum, v) => sum + v.stock, 0);
  if (total === 0) return <Badge tone="bad">Sold out</Badge>;
  if (total <= 5) return <Badge tone="warn">Only {total} left</Badge>;
  return <Badge tone="ok">In stock</Badge>;
}

export function QuantityStepper({
  value,
  max = MAX_QUANTITY_PER_LINE,
  onChange,
  label,
}: {
  value: number;
  max?: number;
  onChange: (value: number) => void;
  label: string;
}) {
  const limit = Math.max(1, Math.min(max, MAX_QUANTITY_PER_LINE));
  const button = "flex size-10 items-center justify-center text-ink hover:bg-sunken disabled:text-subtle disabled:hover:bg-transparent";
  return (
    <div role="group" aria-label={label} className="inline-flex items-center rounded-control border border-line-strong bg-surface">
      <button type="button" className={cn(button, "rounded-l-control")} aria-label="One fewer" disabled={value <= 1} onClick={() => onChange(value - 1)}>
        <Minus className="size-4" aria-hidden />
      </button>
      <span aria-live="polite" className="num w-9 text-center text-sm font-semibold text-ink">
        {value}
      </span>
      <button type="button" className={cn(button, "rounded-r-control")} aria-label="One more" disabled={value >= limit} onClick={() => onChange(value + 1)}>
        <Plus className="size-4" aria-hidden />
      </button>
    </div>
  );
}

/** Link to the cart, with the number of items in it. */
export function CartLink({ className }: { className?: string }) {
  const count = useCart().reduce((sum, line) => sum + line.quantity, 0);
  return (
    <Link
      href="/shop/cart"
      aria-label={count === 0 ? "Cart, empty" : `Cart, ${count} ${count === 1 ? "item" : "items"}`}
      className={cn("relative flex size-10 shrink-0 items-center justify-center rounded-control text-ink hover:bg-sunken", className)}
    >
      <ShoppingCart className="size-5" aria-hidden />
      {count > 0 && (
        <span aria-hidden className="num absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1 text-[0.6875rem] font-bold text-on-brand">
          {count}
        </span>
      )}
    </Link>
  );
}
