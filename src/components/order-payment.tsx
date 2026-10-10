"use client";

import { CircleAlert, CircleCheck, Clock, CreditCard, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Money } from "./domain";
import { Button, Notice } from "./ui";
import { api, errorMessage } from "@/lib/api-client";
import { SETTINGS, type OrderPaymentAction, type OrderPaymentState, type ShopOrder } from "@/lib/contracts";
import { checkoutConstructor, loadCheckout, type CheckoutSuccess } from "@/lib/razorpay-checkout";

/**
 * "Pay online" for one of the signed-in member's orders.
 *
 * The browser asks the server to start the payment, opens Razorpay Checkout
 * with what comes back, and hands the result to the server. Whether the order
 * is paid is only ever read from the server's answer (`onOrder`); a success
 * callback from Checkout on its own changes nothing on screen.
 */
export function PayOrderOnline({ order, onOrder }: { order: ShopOrder; onOrder: (order: ShopOrder) => void }) {
  const [working, setWorking] = useState<"start" | "pay" | "check" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "bad"; title: string; text?: string } | null>(null);
  const [uncertain, setUncertain] = useState(false);

  /** Sends one action and shows what the server now says about the order. */
  async function send(body: OrderPaymentAction): Promise<OrderPaymentState> {
    const state = await api<OrderPaymentState>(`/api/me/orders/${encodeURIComponent(order.code)}/pay`, { method: "POST", body });
    onOrder(state.order);
    return state;
  }

  /** Turns the server's answer after an attempt into the message shown. */
  function report(state: OrderPaymentState, dismissed: boolean) {
    setUncertain(state.processing);
    if (state.order.unpaidCents === 0) {
      setNotice({ tone: "ok", title: "Payment confirmed", text: "This order is paid. The committee will hand it over when you collect it." });
    } else if (state.processing) {
      setNotice({ tone: "warn", title: "Your payment is still being processed", text: "It is not marked paid yet. Check again in a minute; do not pay twice." });
    } else if (state.failureReason) {
      setNotice({ tone: "bad", title: "The payment did not go through", text: `${state.failureReason} The order is still unpaid.` });
    } else if (dismissed) {
      setNotice({ tone: "warn", title: "Payment not completed", text: "The order is still unpaid. You can try again." });
    } else {
      setNotice(null);
    }
  }

  async function settle(body: OrderPaymentAction, dismissed = false) {
    try {
      report(await send(body), dismissed);
    } catch (error) {
      // Not known whether it went through: make the member check before trying again.
      setUncertain(true);
      setNotice({ tone: "bad", title: "We could not confirm the payment", text: `${errorMessage(error)} Check again before paying a second time.` });
    } finally {
      setWorking(null);
    }
  }

  async function pay() {
    if (working) return;
    setNotice(null);
    setWorking("start");
    try {
      const state = await send({ action: "start" });
      if (!state.checkout) {
        // Already paid, or still processing: nothing to open.
        report(state, false);
        setWorking(null);
        return;
      }
      setWorking("pay");
      await loadCheckout();
      const Razorpay = checkoutConstructor();
      let finished = false;
      const checkoutWindow = new Razorpay({
        key: state.checkout.keyId,
        order_id: state.checkout.orderId,
        amount: state.checkout.amountCents,
        currency: state.checkout.currency,
        name: SETTINGS.orgName,
        description: `Merchandise order ${order.code}`,
        prefill: { name: state.checkout.name, email: state.checkout.email, contact: state.checkout.phone ?? undefined },
        handler: (response: CheckoutSuccess) => {
          finished = true;
          // The server decides whether this is a real payment.
          void settle({
            action: "confirm",
            razorpayOrderId: response.razorpay_order_id,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpaySignature: response.razorpay_signature,
          });
        },
        modal: {
          ondismiss: () => {
            // Closed without a result. It may still have gone through, so ask the server.
            if (!finished) void settle({ action: "check" }, true);
          },
        },
      });
      checkoutWindow.on("payment.failed", (response) => {
        void send({ action: "failed", reason: response.error?.description?.slice(0, 200) ?? null }).catch(() => undefined);
      });
      checkoutWindow.open();
    } catch (error) {
      setNotice({ tone: "bad", title: "The payment could not be started", text: errorMessage(error) });
      setWorking(null);
    }
  }

  async function check() {
    if (working) return;
    setWorking("check");
    await settle({ action: "check" });
  }

  const owes = order.unpaidCents > 0;
  if (!notice && !(owes && order.payOnline)) return null;

  return (
    <div className="space-y-3">
      {notice && (
        <Notice tone={notice.tone} icon={notice.tone === "ok" ? CircleCheck : notice.tone === "warn" ? Clock : CircleAlert} title={notice.title}>
          {notice.text}
        </Notice>
      )}
      {owes && order.payOnline && (
        <div className="flex flex-wrap items-center gap-2">
          {uncertain ? (
            <Button icon={RefreshCw} loading={working === "check"} disabled={working !== null} onClick={check}>
              Check payment status
            </Button>
          ) : (
            <Button icon={CreditCard} loading={working === "start" || working === "pay"} disabled={working !== null} onClick={pay}>
              Pay <Money cents={order.unpaidCents} /> online
            </Button>
          )}
          <span className="text-[0.8125rem] text-muted">Or pay the committee when you collect it.</span>
        </div>
      )}
    </div>
  );
}
