"use client";

import { useSyncExternalStore } from "react";
import { MAX_QUANTITY_PER_LINE } from "./contracts";

/**
 * The shopping cart. It lives in this browser only and holds what was chosen:
 * which size, and how many. The name and price kept beside each line are for
 * display; the server works out the real price at checkout.
 */
export interface CartLine {
  variantId: string;
  productId: string;
  name: string;
  size: string;
  /** Price shown when the item was added. Display only. */
  priceCents: number;
  imageUrl: string | null;
  quantity: number;
}

const KEY = "skyline.cart.v1";
const EMPTY: CartLine[] = [];
const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cached: CartLine[] = EMPTY;

function read(): CartLine[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    // storage blocked: behave as an empty cart
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cached = Array.isArray(parsed)
      ? parsed.filter((l): l is CartLine => !!l && typeof l.variantId === "string" && Number.isInteger(l.quantity) && l.quantity > 0)
      : EMPTY;
  } catch {
    cached = EMPTY;
  }
  return cached;
}

function write(lines: CartLine[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // storage blocked: the cart will not survive a reload
  }
  cachedRaw = null;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

const clamp = (quantity: number) => Math.max(1, Math.min(MAX_QUANTITY_PER_LINE, Math.floor(quantity)));

export const cart = {
  add(line: CartLine): void {
    const lines = read();
    const existing = lines.find((l) => l.variantId === line.variantId);
    write(
      existing
        ? lines.map((l) => (l.variantId === line.variantId ? { ...line, quantity: clamp(l.quantity + line.quantity) } : l))
        : [...lines, { ...line, quantity: clamp(line.quantity) }],
    );
  },
  setQuantity(variantId: string, quantity: number): void {
    write(read().map((l) => (l.variantId === variantId ? { ...l, quantity: clamp(quantity) } : l)));
  },
  remove(variantId: string): void {
    write(read().filter((l) => l.variantId !== variantId));
  },
  clear(): void {
    write([]);
  },
};

/** The cart's lines. Empty on the server and during the first render, then filled from storage. */
export function useCart(): CartLine[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
