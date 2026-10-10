/**
 * Loading Razorpay Checkout in the browser. Shared by the membership and
 * merchandise payment screens. Checkout only collects the payment; whether it
 * succeeded is always decided by the server afterwards.
 */

const CHECKOUT_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";

/** What Checkout hands back on success. The server verifies it before anything is marked paid. */
export interface CheckoutSuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface CheckoutInstance {
  open(): void;
  on(event: "payment.failed", handler: (response: { error?: { description?: string } }) => void): void;
}

export type CheckoutConstructor = new (options: Record<string, unknown>) => CheckoutInstance;

let scriptLoading: Promise<void> | null = null;

export function loadCheckout(): Promise<void> {
  if ((window as unknown as { Razorpay?: CheckoutConstructor }).Razorpay) return Promise.resolve();
  scriptLoading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoading = null;
      script.remove();
      reject(new Error("The payment window could not be loaded. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return scriptLoading;
}

/** The Checkout constructor, once `loadCheckout` has resolved. */
export const checkoutConstructor = (): CheckoutConstructor =>
  (window as unknown as { Razorpay: CheckoutConstructor }).Razorpay;
