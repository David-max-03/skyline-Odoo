import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cart lives in the browser's localStorage. These tests give the module a
 * small stand-in for `window`, so the real store runs: reading, writing,
 * notifying listeners, and the sign-out and change-of-account rules.
 */

class FakeStorage {
  private items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
  removeItem = (key: string) => void this.items.delete(key);
  keys = () => [...this.items.keys()].sort();
}

let storage: FakeStorage;
let cartModule: typeof import("@/lib/cart");

const hoodie = { variantId: "var_m", productId: "prd_1", name: "Hoodie", size: "M", priceCents: 100000, imageUrl: null, quantity: 1 };
const tee = { variantId: "var_l", productId: "prd_2", name: "Tee", size: "L", priceCents: 38000, imageUrl: null, quantity: 2 };

/** What the cart badge would show: the lines as a fresh read of storage sees them. */
const stored = (): { variantId: string; quantity: number }[] => JSON.parse(storage.getItem("skyline.cart.v1") ?? "[]");
const badge = () => stored().reduce((n, l) => n + l.quantity, 0);

beforeEach(async () => {
  storage = new FakeStorage();
  vi.stubGlobal("window", { localStorage: storage, addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.resetModules();
  cartModule = await import("@/lib/cart");
});

describe("the cart while one person shops", () => {
  it("keeps what was added, across reloads and navigation", async () => {
    const { cart } = cartModule;
    cart.syncOwner("mem_a");
    cart.add(hoodie);
    cart.add(tee);
    cart.add(hoodie);
    expect(stored().map((l) => [l.variantId, l.quantity])).toEqual([["var_m", 2], ["var_l", 2]]);
    expect(badge()).toBe(4);

    // A reload: the module starts again and reads the same storage. The same person is still signed in.
    vi.resetModules();
    const reloaded = (await import("@/lib/cart")).cart;
    reloaded.syncOwner("mem_a");
    reloaded.setQuantity("var_l", 1);
    expect(badge()).toBe(3);
    reloaded.remove("var_m");
    expect(stored().map((l) => l.variantId)).toEqual(["var_l"]);
  });

  it("carries a visitor's cart over when they sign in", () => {
    const { cart } = cartModule;
    cart.syncOwner(null);
    cart.add(hoodie);
    cart.syncOwner("mem_a"); // they sign in to check out
    expect(badge()).toBe(1);
    expect(storage.getItem("skyline.cart.owner")).toBe("mem_a");
    cart.syncOwner("mem_a");
    expect(badge()).toBe(1);
  });
});

describe("signing out", () => {
  it("empties the cart and its stored data, and tells the badge at once", () => {
    const { cart } = cartModule;
    cart.syncOwner("mem_a");
    cart.add(hoodie);
    cart.add(tee);
    let notified = 0;
    // The badge is subscribed to the store through React; a listener stands in for it here.
    const originalSet = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === "skyline.cart.v1") notified += 1;
      originalSet(key, value);
    };

    cart.clear(); // what both sign-out buttons call
    expect(notified).toBe(1);
    expect(badge()).toBe(0);
    expect(stored()).toEqual([]);
    expect(storage.getItem("skyline.cart.owner")).toBeNull();
    expect(JSON.stringify(storage.keys().map((k) => storage.getItem(k)))).not.toContain("Hoodie");
  });

  it("leaves nothing for the next person who signs in on the same browser", () => {
    const { cart } = cartModule;
    cart.syncOwner("mem_a");
    cart.add(hoodie);
    cart.clear(); // A signs out

    cart.syncOwner(null); // the public page, nobody signed in
    expect(badge()).toBe(0);
    cart.syncOwner("mem_b"); // B signs in
    expect(badge()).toBe(0);
    cart.add(tee);
    expect(stored().map((l) => l.variantId)).toEqual(["var_l"]);
    expect(storage.getItem("skyline.cart.owner")).toBe("mem_b");
  });
});

describe("a cart left behind without signing out", () => {
  it("is dropped when the session has ended, and when a different account signs in", async () => {
    const { cart } = cartModule;
    cart.syncOwner("mem_a");
    cart.add(hoodie);

    // A's session expires; the next page load finds nobody signed in.
    vi.resetModules();
    let next = (await import("@/lib/cart")).cart;
    next.syncOwner(null);
    expect(badge()).toBe(0);

    // Or B signs in straight away while A's cart is still stored.
    storage.setItem("skyline.cart.v1", JSON.stringify([hoodie]));
    storage.setItem("skyline.cart.owner", "mem_a");
    vi.resetModules();
    next = (await import("@/lib/cart")).cart;
    next.syncOwner("mem_b");
    expect(badge()).toBe(0);
    expect(storage.getItem("skyline.cart.owner")).toBe("mem_b");
  });

  it("does not empty a cart for its own owner, or a visitor's cart for a visitor", () => {
    const { cart, reconcileOwner } = cartModule;
    expect(reconcileOwner("mem_a", "mem_a")).toEqual({ owner: "mem_a", clear: false });
    expect(reconcileOwner(null, null)).toEqual({ owner: null, clear: false });
    expect(reconcileOwner(null, "mem_a")).toEqual({ owner: "mem_a", clear: false });
    expect(reconcileOwner("mem_a", "mem_b")).toEqual({ owner: "mem_b", clear: true });
    expect(reconcileOwner("mem_a", null)).toEqual({ owner: null, clear: true });

    cart.syncOwner(null);
    cart.add(hoodie);
    cart.syncOwner(null);
    cart.syncOwner(null);
    expect(badge()).toBe(1);
  });

  it("behaves as an empty cart when storage is blocked", async () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.resetModules();
    const { cart } = await import("@/lib/cart");
    expect(() => { cart.syncOwner("mem_a"); cart.add(hoodie); cart.clear(); }).not.toThrow();
  });
});
