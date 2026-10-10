"use client";

import { CircleAlert, RefreshCw, UserPlus } from "lucide-react";
import { useState } from "react";
import { SetupLinkDialog } from "./applications-panel";
import { Money } from "./domain";
import { Dialog, DialogActions, useToast } from "./overlay";
import { Badge, Button, Card, CardHeader, ErrorState, FormError, TextAreaField, type Tone } from "./ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import {
  ONLINE_APPLICATION_STATUS_LABELS,
  type OnlineApplicationStatus,
  type OnlinePayment,
  type OnlineReconcileAction,
  type OnlineReconcileResult,
  type SetupLink,
} from "@/lib/contracts";
import { formatShortDateTime } from "@/lib/dates";

const STATUS_TONES: Record<OnlineApplicationStatus, Tone> = {
  pending: "neutral",
  failed: "bad",
  superseded: "neutral",
  activated: "ok",
  needs_review: "warn",
  refunded: "neutral",
};

/**
 * Membership fees paid online through Razorpay. Most need nothing from the
 * committee. The ones that do are a payment that could not become a member
 * (finish it or refund it) and an applicant who paid but was never told so
 * (check the order with Razorpay).
 */
export function OnlinePaymentsPanel({ onMemberCreated }: { onMemberCreated: () => void }) {
  const toast = useToast();
  const { data, error, reload } = useApi<OnlinePayment[]>("/api/online-applications");
  const [working, setWorking] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<OnlinePayment | null>(null);
  const [note, setNote] = useState("");
  const [noteErrors, setNoteErrors] = useState<Record<string, string>>({});
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [link, setLink] = useState<SetupLink | null>(null);

  async function reconcile(payment: OnlinePayment, body: OnlineReconcileAction): Promise<boolean> {
    setWorking(`${payment.id}:${body.action}`);
    try {
      const result = await api<OnlineReconcileResult>(`/api/online-applications/${payment.id}`, { method: "POST", body });
      reload();
      if (result.setup) {
        toast.success(`${result.payment.name} is now member ${result.payment.memberNo}.`);
        setLink(result.setup);
        onMemberCreated();
      } else if (body.action === "refunded") {
        toast.success(`Payment from ${payment.name} recorded as refunded.`);
      } else if (result.payment.status === "needs_review") {
        toast.error(`Razorpay confirms ${payment.name} paid, but the member could not be created. See the reason below.`);
      }
      return true;
    } catch (err) {
      if (body.action === "refunded") {
        setNoteErrors(fieldErrors(err));
        setDialogError(errorMessage(err));
      } else {
        toast.error(errorMessage(err));
        reload();
      }
      return false;
    } finally {
      setWorking(null);
    }
  }

  if (error && !data) {
    return (
      <Card className="mb-6">
        <ErrorState message={error.message} onRetry={reload} />
      </Card>
    );
  }
  if (!data || data.length === 0) return null;

  const review = data.filter((p) => p.status === "needs_review");
  const unpaid = data.filter((p) => p.status === "pending" || p.status === "failed");
  const settled = data.filter((p) => p.status === "activated" || p.status === "refunded").slice(0, 8);

  const row = (p: OnlinePayment, actions: React.ReactNode) => (
    <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
      <div className="min-w-0 text-sm">
        <p className="font-medium text-ink">
          {p.name}
          {p.memberNo && <span className="font-mono font-normal text-muted"> · {p.memberNo}</span>}
        </p>
        <p className="truncate text-[0.8125rem] text-muted">
          {p.email} · <Money cents={p.amountCents} />
          {p.paymentMethod && ` · ${p.paymentMethod}`}
        </p>
        <p className="break-all text-[0.8125rem] text-muted">
          <span className="font-mono">{p.code}</span> · <span className="font-mono">{p.razorpayPaymentId ?? p.razorpayOrderId}</span> ·{" "}
          {p.paidAt ? `paid ${formatShortDateTime(p.paidAt)}` : `started ${formatShortDateTime(p.createdAt)}`}
        </p>
        {p.status === "needs_review" && p.reviewReason && <p className="mt-1 text-[0.8125rem] text-warn">{p.reviewReason}</p>}
        {p.status === "failed" && p.failureReason && <p className="mt-1 text-[0.8125rem] text-muted">Last attempt: {p.failureReason}</p>}
        {p.status === "activated" && p.reviewReason && <p className="mt-1 text-[0.8125rem] text-warn">{p.reviewReason}</p>}
        {p.status === "activated" && !p.hasAccount && (
          <p className="mt-1 text-[0.8125rem] text-muted">No password set yet. Create a setup link from their member record if they ask.</p>
        )}
        {p.status === "refunded" && p.resolutionNote && (
          <p className="mt-1 text-[0.8125rem] text-muted">
            {p.resolutionNote}
            {p.resolvedByName && ` · ${p.resolvedByName}`}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONES[p.status]} icon={p.status === "needs_review" ? CircleAlert : undefined}>
          {ONLINE_APPLICATION_STATUS_LABELS[p.status]}
        </Badge>
        {actions}
      </div>
    </li>
  );

  return (
    <>
      <Card className="mb-6">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Online payments
              {review.length > 0 && <Badge tone="warn">{review.length} to review</Badge>}
            </span>
          }
          description="Membership fees paid through Razorpay. A member is created only after Razorpay confirms the payment to the server."
        />
        {review.length + unpaid.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">Nothing needs attention.</p>
        ) : (
          <ul className="divide-y divide-line">
            {review.map((p) =>
              row(
                p,
                <>
                  <Button size="sm" icon={UserPlus} loading={working === `${p.id}:activate`} onClick={() => reconcile(p, { action: "activate" })}>
                    Create member
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setNote("");
                      setNoteErrors({});
                      setDialogError(null);
                      setRefunding(p);
                    }}
                  >
                    Mark refunded
                  </Button>
                </>,
              ),
            )}
            {unpaid.map((p) =>
              row(
                p,
                <Button size="sm" variant="secondary" icon={RefreshCw} loading={working === `${p.id}:check`} onClick={() => reconcile(p, { action: "check" })}>
                  Check with Razorpay
                </Button>,
              ),
            )}
          </ul>
        )}
        {settled.length > 0 && (
          <details className="border-t border-line text-sm">
            <summary className="px-5 py-3 font-medium text-muted hover:text-ink">Recent online payments</summary>
            <ul className="divide-y divide-line border-t border-line">{settled.map((p) => row(p, null))}</ul>
          </details>
        )}
      </Card>

      <Dialog open={refunding !== null} onClose={() => setRefunding(null)} title="Mark payment as refunded" description={refunding?.code}>
        {refunding && (
          <div className="space-y-4 text-sm">
            <FormError message={dialogError} />
            <p>
              This only records the refund here. Refund <span className="font-mono">{refunding.razorpayPaymentId}</span> in the Razorpay
              dashboard first; Skyline does not move the money.
            </p>
            <TextAreaField
              label="Note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              error={noteErrors.note}
              hint="For example the refund ID and why the membership was not created."
              autoFocus
            />
            <DialogActions>
              <Button variant="secondary" onClick={() => setRefunding(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={working === `${refunding.id}:refunded`}
                onClick={async () => {
                  if (await reconcile(refunding, { action: "refunded", note })) setRefunding(null);
                }}
              >
                Record refund
              </Button>
            </DialogActions>
          </div>
        )}
      </Dialog>

      <SetupLinkDialog link={link} onClose={() => setLink(null)} />
    </>
  );
}
