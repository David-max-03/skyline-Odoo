"use client";

import { Check, CircleAlert, Clock, CreditCard, KeyRound, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Money } from "./domain";
import { Button, Card, FormError, LinkButton, Notice, Skeleton, TextField } from "./ui";
import { ApiError, api, errorMessage, fieldErrors } from "@/lib/api-client";
import {
  SETTINGS,
  type OnlineApplicationAction,
  type OnlineApplicationStart,
  type OnlineApplicationState,
  type OnlineCheckout,
} from "@/lib/contracts";
import { formatDateTime } from "@/lib/dates";

/**
 * Paying the membership fee online. The browser only opens Razorpay Checkout
 * and passes its result to the server. What is shown here always comes back
 * from the server, which verifies the payment with Razorpay itself; nothing on
 * this page can make anyone a member.
 */

const CHECKOUT_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";
/** The application this browser started: its id and access token. Never the password link. */
const STORAGE_KEY = "skyline.join.online";

interface CheckoutSuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}
interface CheckoutInstance {
  open(): void;
  on(event: "payment.failed", handler: (response: { error?: { description?: string } }) => void): void;
}
type CheckoutConstructor = new (options: Record<string, unknown>) => CheckoutInstance;

let scriptLoading: Promise<void> | null = null;
function loadCheckout(): Promise<void> {
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

interface Saved {
  id: string;
  token: string;
}
function readSaved(): Saved | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Saved> | null;
    return saved && typeof saved.id === "string" && typeof saved.token === "string" ? { id: saved.id, token: saved.token } : null;
  } catch {
    return null;
  }
}
function writeSaved(saved: Saved | null): void {
  try {
    if (saved) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage is unavailable (private window). The payment still works; only coming back later does not.
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ActionBody = DistributiveOmit<OnlineApplicationAction, "token">;

export function OnlineJoin() {
  const [values, setValues] = useState({ name: "", email: "", studentId: "", phone: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState<"start" | "pay" | "check" | "link" | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [state, setState] = useState<OnlineApplicationState | null>(null);
  const saved = useRef<Saved | null>(null);

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  const forget = useCallback(() => {
    saved.current = null;
    writeSaved(null);
    setState(null);
    setFormError(null);
  }, []);

  /** Sends one action for this browser's application and shows whatever the server answers. */
  const act = useCallback(
    async (body: ActionBody): Promise<OnlineApplicationState | null> => {
      const current = saved.current;
      if (!current) return null;
      try {
        const next = await api<OnlineApplicationState>(`/api/public/membership/online/${current.id}`, {
          method: "POST",
          body: { ...body, token: current.token },
        });
        // A link already on screen stays there when a later answer does not carry one.
        setState((previous) => ({ ...next, setup: next.setup ?? (previous?.id === next.id ? previous.setup : null) }));
        return next;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) forget();
        throw error;
      }
    },
    [forget],
  );

  // Coming back to the page: pick the application up where it was left.
  useEffect(() => {
    let cancelled = false;
    saved.current = readSaved();
    (async () => {
      try {
        if (saved.current) await act({ action: "resume" });
      } catch {
        // Shown as the empty form; the applicant can check their status with the code instead.
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [act]);

  async function openCheckout(checkout: OnlineCheckout) {
    setFormError(null);
    setWorking("pay");
    try {
      await loadCheckout();
      const Razorpay = (window as unknown as { Razorpay: CheckoutConstructor }).Razorpay;
      let finished = false;
      const settle = async (body: ActionBody) => {
        try {
          await act(body);
        } catch (error) {
          setFormError(errorMessage(error));
        } finally {
          setWorking(null);
        }
      };
      const checkoutWindow = new Razorpay({
        key: checkout.keyId,
        order_id: checkout.orderId,
        amount: checkout.amountCents,
        currency: checkout.currency,
        name: SETTINGS.orgName,
        description: "Membership fee",
        prefill: { name: checkout.name, email: checkout.email, contact: checkout.phone ?? undefined },
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
            // Closed without a result. The payment may still have gone through, so ask the server.
            if (!finished) void settle({ action: "resume" });
          },
        },
      });
      checkoutWindow.on("payment.failed", (response) => {
        void act({ action: "failed", reason: response.error?.description?.slice(0, 200) ?? null }).catch(() => undefined);
      });
      checkoutWindow.open();
    } catch (error) {
      setFormError(errorMessage(error));
      setWorking(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setErrors({});
    setWorking("start");
    try {
      const started = await api<OnlineApplicationStart>("/api/public/membership/online", { method: "POST", body: values });
      const { accessToken, ...next } = started;
      saved.current = { id: next.id, token: accessToken };
      writeSaved(saved.current);
      setState(next);
      if (next.checkout) await openCheckout(next.checkout);
      else setWorking(null);
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
      setWorking(null);
    }
  }

  async function run(kind: "check" | "link", body: ActionBody) {
    setFormError(null);
    setWorking(kind);
    try {
      await act(body);
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  if (restoring) {
    return (
      <Card className="p-5">
        <Skeleton className="h-40" />
      </Card>
    );
  }

  const heading = (
    <h2 className="mb-4 flex items-center gap-2 text-[0.9375rem] font-semibold">
      <CreditCard className="size-4 text-brand" aria-hidden />
      Pay online and join now
    </h2>
  );

  if (!state) {
    return (
      <Card className="p-5">
        {heading}
        <p className="mb-4 text-sm">
          Pay <Money cents={SETTINGS.membershipFeeCents} /> by UPI, card or netbanking. Your membership starts as soon as the payment is
          confirmed. No screenshot, no waiting for approval.
        </p>
        <form onSubmit={submit} noValidate className="space-y-4">
          <FormError message={formError} />
          <TextField label="Full name" autoComplete="name" value={values.name} onChange={set("name")} error={errors.name} required />
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            value={values.email}
            onChange={set("email")}
            error={errors.email}
            hint="You will sign in with this."
            required
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Student ID" value={values.studentId} onChange={set("studentId")} error={errors.studentId} optional />
            <TextField label="Phone" type="tel" autoComplete="tel" value={values.phone} onChange={set("phone")} error={errors.phone} optional />
          </div>
          <Button type="submit" size="lg" icon={CreditCard} loading={working === "start" || working === "pay"}>
            Continue to payment
          </Button>
          <p className="text-[0.8125rem] text-muted">
            Payment is handled by Razorpay. Skyline never sees your card or UPI details. On a phone you can pay in your UPI app; on a computer
            you can scan a code with your phone where Razorpay offers one.
          </p>
        </form>
      </Card>
    );
  }

  const code = (
    <p className="mt-4 text-sm text-muted">
      Application code <span className="font-mono font-semibold text-ink">{state.code}</span>
    </p>
  );

  if (state.status === "activated") {
    return (
      <Card className="p-5">
        <Notice tone="ok" icon={Check} title={`Payment confirmed. You are member ${state.memberNo}.`}>
          Your membership is active.
        </Notice>
        <FormError message={formError} />
        {state.setup ? (
          <div className="mt-5 space-y-3 text-sm">
            <p>Set a password now to open your member account. You sign in with your email or member ID.</p>
            <LinkButton href={state.setup.path} size="lg">
              Set your password
            </LinkButton>
            <p className="text-muted">
              This link works once and expires {formatDateTime(state.setup.expiresAt)}. It is shown only here; Skyline does not email it.
            </p>
          </div>
        ) : state.canRequestLink ? (
          <div className="mt-5 space-y-3 text-sm">
            <p>Your password link was already shown. If you lost it, get a new one; the old link stops working.</p>
            <Button variant="secondary" icon={KeyRound} loading={working === "link"} onClick={() => run("link", { action: "new_link" })}>
              Get a new password link
            </Button>
          </div>
        ) : (
          <p className="mt-5 text-sm">
            Sign in with your email or member ID. If you never set a password, ask the committee for a password link.
          </p>
        )}
        {code}
        <div className="mt-4 flex flex-wrap gap-3">
          {!state.setup && (
            <LinkButton href="/login" variant="secondary">
              Sign in
            </LinkButton>
          )}
          {!state.canRequestLink && (
            <Button variant="ghost" onClick={forget}>
              Done
            </Button>
          )}
        </div>
      </Card>
    );
  }

  if (state.status === "needs_review") {
    return (
      <Card className="p-5">
        <Notice tone="warn" icon={CircleAlert} title="Payment received. Your membership needs a committee member to finish it.">
          Your payment is recorded and you will not be charged again. Do not pay a second time. Give the committee the code below; they will
          either complete your membership or refund you.
        </Notice>
        {code}
      </Card>
    );
  }

  if (state.status === "refunded" || state.status === "superseded" || !state.checkout) {
    return (
      <Card className="p-5">
        <Notice tone="warn" icon={CircleAlert} title={state.status === "refunded" ? "This payment was refunded" : "This application is closed"}>
          {state.status === "refunded"
            ? "The committee returned this payment. You can apply again."
            : state.status === "superseded"
              ? "A newer application was started with this email. Nothing was charged for this one."
              : "Online payment is not available right now. Try again later or use the form below."}
        </Notice>
        {code}
        <Button variant="secondary" className="mt-4" onClick={forget}>
          Start a new application
        </Button>
      </Card>
    );
  }

  // pending or failed: not paid yet, and payable again on the same order.
  const checkout = state.checkout;
  return (
    <Card className="p-5">
      {heading}
      {state.processing ? (
        <Notice tone="warn" icon={Clock} title="Your payment is still being processed">
          Razorpay has not confirmed it yet. You are not a member until it does. Check again in a minute; do not pay twice.
        </Notice>
      ) : state.status === "failed" ? (
        <Notice tone="bad" icon={CircleAlert} title="The payment did not go through">
          {state.failureReason ?? "Nothing was confirmed."} You have not become a member. You can try again.
        </Notice>
      ) : (
        <Notice tone="warn" icon={Clock} title="Not paid yet">
          Your application is saved. Pay <Money cents={state.amountCents} /> to become a member.
        </Notice>
      )}
      <FormError message={formError} />
      <div className="mt-4 flex flex-wrap gap-3">
        <Button size="lg" icon={CreditCard} loading={working === "pay"} disabled={working !== null} onClick={() => openCheckout(checkout)}>
          {state.status === "failed" ? "Try the payment again" : "Pay now"}
        </Button>
        <Button variant="secondary" icon={RefreshCw} loading={working === "check"} disabled={working !== null} onClick={() => run("check", { action: "resume" })}>
          I have paid, check again
        </Button>
        <Button variant="ghost" disabled={working !== null} onClick={forget}>
          Use different details
        </Button>
      </div>
      {code}
    </Card>
  );
}
