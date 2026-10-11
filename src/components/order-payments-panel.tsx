"use client";

import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { Money } from "./domain";
import { Dialog, DialogActions, useToast } from "./overlay";
import { useCan } from "./session";
import { Badge, Button, Card, CardHeader, FormError, TextAreaField } from "./ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import type { OrderPaymentRecord } from "@/lib/contracts";
import { formatShortDateTime } from "@/lib/dates";

/**
 * Online merchandise payments that need the committee: money that arrived for
 * an item which was already paid in cash, or cancelled, while the member was
 * paying. Shown only when there is one. Ordinary online payments need nothing
 * here; they mark the order paid on their own.
 */
export function OrderPaymentsPanel() {
  const toast = useToast();
  const canRefund = useCan("processRefunds");
  const { data, reload } = useApi<OrderPaymentRecord[]>("/api/order-payments");
  const [refunding, setRefunding] = useState<OrderPaymentRecord | null>(null);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const review = (data ?? []).filter((p) => p.status === "needs_review");
  if (review.length === 0) return null;

  async function record() {
    if (!refunding) return;
    setWorking(true);
    setFormError(null);
    setErrors({});
    try {
      await api(`/api/order-payments/${refunding.id}`, { method: "POST", body: { action: "refunded", note } });
      toast.success(`Refund for ${refunding.orderCode} recorded.`);
      setRefunding(null);
      reload();
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <Card className="mb-6">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Online payments to refund
              <Badge tone="warn">{review.length}</Badge>
            </span>
          }
          description="Razorpay confirmed these payments, but part of each was for an item already paid or cancelled."
        />
        <ul className="divide-y divide-line">
          {review.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
              <div className="min-w-0 text-sm">
                <p className="font-medium text-ink">
                  {p.memberName} <span className="font-mono font-normal text-muted">· {p.memberNo}</span>
                </p>
                <p className="break-all text-[0.8125rem] text-muted">
                  <span className="font-mono">{p.orderCode}</span> · <span className="font-mono">{p.razorpayPaymentId}</span>
                  {p.paidAt && ` · paid ${formatShortDateTime(p.paidAt)}`}
                </p>
                <p className="mt-1 text-[0.8125rem] text-warn">
                  Paid <Money cents={p.amountCents} />, of which <Money cents={p.amountCents - (p.appliedCents ?? 0)} /> was not owed.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="warn" icon={CircleAlert}>
                  Refund due
                </Badge>
                {canRefund ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setNote("");
                      setErrors({});
                      setFormError(null);
                      setRefunding(p);
                    }}
                  >
                    Mark refunded
                  </Button>
                ) : (
                  <span className="text-[0.8125rem] text-muted">President records refunds</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Dialog open={refunding !== null} onClose={() => setRefunding(null)} title="Mark as refunded" description={refunding?.orderCode}>
        {refunding && (
          <div className="space-y-4 text-sm">
            <FormError message={formError} />
            <p>
              This only records the refund here. Refund <Money cents={refunding.amountCents - (refunding.appliedCents ?? 0)} /> of{" "}
              <span className="font-mono">{refunding.razorpayPaymentId}</span> in the Razorpay dashboard first; Skyline does not move the
              money.
            </p>
            <TextAreaField
              label="Note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              error={errors.note}
              hint="For example the refund ID."
              autoFocus
            />
            <DialogActions>
              <Button variant="secondary" onClick={() => setRefunding(null)}>
                Cancel
              </Button>
              <Button variant="danger" loading={working} onClick={record}>
                Record refund
              </Button>
            </DialogActions>
          </div>
        )}
      </Dialog>
    </>
  );
}
