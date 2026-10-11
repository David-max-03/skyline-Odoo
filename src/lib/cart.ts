"use client";

import { useSyncExternalStore } from "react";
import { MAX_QUANTITY_PER_LINE } from "./contracts";

/**
 * The shopping cart. It lives in this browser only and holds what was chosen:
 * which size, and how many. The name and price kept beside each line are for
 * display; the server works out the real price at checkout.
 *
 * A cart belongs to whoever filled it. Signing out empties it, and a cart
 * left behind by one account is never shown to another: see `syncOwner`.
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
/** The account the cart belongs to. Absent while it is a visitor's. Never a secret: an id only. */
const OWNER_KEY = "skyline.cart.owner";
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

function readOwner(): string | null {
  try {
    return window.localStorage.getItem(OWNER_KEY) || null;
  } catch {
    return null;
  }
}

function writeOwner(owner: string | null): void {
  try {
    if (owner) window.localStorage.setItem(OWNER_KEY, owner);
    else window.localStorage.removeItem(OWNER_KEY);
  } catch {
    // storage blocked: nothing persists anyway
  }
}

/**
 * What to do with a stored cart given who is looking at it now.
 * - It belongs to another account, or to an account and nobody is signed in:
 *   it is not this person's, so it is emptied.
 * - It is a visitor's and they have just signed in: it becomes theirs.
 * - Otherwise nothing changes.
 */
export function reconcileOwner(storedOwner: string | null, current: string | null): { owner: string | null; clear: boolean } {
  if (storedOwner && storedOwner !== current) return { owner: current, clear: true };
  return { owner: current ?? storedOwner, clear: false };
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
  /** Empties the cart and forgets whose it was. Called at checkout and on sign-out. */
  clear(): void {
    writeOwner(null);
    write([]);
  },
  /**
   * Tells the cart who is looking at it: an account id, or null for a visitor.
   * Call it whenever the session is known. A cart that belongs to someone else
   * is emptied, so it cannot leak from one account to the next on a shared browser.
   */
  syncOwner(current: string | null): void {
    const decision = reconcileOwner(readOwner(), current);
    if (decision.clear) {
      writeOwner(decision.owner);
      write([]);
    } else if (decision.owner !== readOwner()) {
      writeOwner(decision.owner);
    }
  },
};

/** The cart's lines. Empty on the server and during the first render, then filled from storage. */
export function useCart(): CartLine[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
