"use client";

import { Check, Hourglass, X } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogActions, useToast } from "./overlay";
import { Badge, Button, Card, CardHeader, ErrorState, FormError, TableSkeleton, TextAreaField, type Tone } from "./ui";
import { api, errorMessage, useApi } from "@/lib/api-client";
import { VOLUNTEER_REQUEST_STATUS_LABELS, type VolunteerRequest, type VolunteerRequestStatus } from "@/lib/contracts";
import { formatDate, formatShortDateTime } from "@/lib/dates";

const STATUS_TONES: Record<VolunteerRequestStatus, Tone> = { pending: "warn", approved: "ok", rejected: "bad", withdrawn: "neutral" };

/**
 * Members' requests to volunteer for a task, for the president and event
 * organizers. Approving assigns the member to the task if a position is still
 * free; the server decides that, so two people approving at once cannot overfill it.
 */
export function VolunteerRequestsPanel({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const { data, error, reload } = useApi<VolunteerRequest[]>("/api/volunteer-requests");
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<VolunteerRequest | null>(null);
  const [reason, setReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);

  async function review(request: VolunteerRequest, body: { action: "approve" } | { action: "reject"; reason: string | null }) {
    setBusy(`${request.id}:${body.action}`);
    setDialogError(null);
    try {
      await api<VolunteerRequest>(`/api/volunteer-requests/${request.id}`, { method: "POST", body });
      toast.success(
        body.action === "approve"
          ? `${request.memberName} is now on "${request.taskTitle}".`
          : `Request from ${request.memberName} rejected.`,
      );
      setRejecting(null);
      return true;
    } catch (err) {
      // Typically: the task filled up, or someone else already dealt with it.
      if (body.action === "reject") setDialogError(errorMessage(err));
      else toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
      reload();
      onChanged();
    }
  }

  if (error && !data) {
    return (
      <Card className="mb-6">
        <ErrorState message={error.message} onRetry={reload} />
      </Card>
    );
  }
  if (!data) {
    return (
      <Card className="mb-6">
        <TableSkeleton label="Loading volunteer requests" rows={2} />
      </Card>
    );
  }
  if (data.length === 0) return null;

  const pending = data.filter((r) => r.status === "pending");
  const decided = data.filter((r) => r.status !== "pending").slice(0, 8);

  return (
    <>
      <Card className="mb-6">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Volunteer requests
              {pending.length > 0 && <Badge tone="warn">{pending.length} pending</Badge>}
            </span>
          }
          description="Members who have asked to help with a task. Nobody is assigned until you approve."
        />
        {pending.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">No requests are waiting.</p>
        ) : (
          <ul className="divide-y divide-line">
            {pending.map((r) => {
              const full = r.remaining === 0;
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0 text-sm">
                    <p className="font-medium text-ink">
                      {r.memberName} <span className="font-mono font-normal text-muted">· {r.memberNo}</span>
                    </p>
                    <p className="text-ink">{r.taskTitle}</p>
                    <p className="text-[0.8125rem] text-muted">
                      {r.eventTitle ? `${r.eventTitle}${r.eventStartsAt ? `, ${formatDate(r.eventStartsAt.slice(0, 10))}` : ""}` : "Not tied to an event"} · asked{" "}
                      {formatShortDateTime(r.requestedAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={full ? "ok" : "brand"}>
                      {full ? `Fully staffed · ${r.approved} of ${r.needed}` : `${r.approved} of ${r.needed} approved · ${r.remaining} open`}
                    </Badge>
                    <Badge tone="warn" icon={Hourglass}>
                      Pending
                    </Badge>
                    <Button
                      size="sm"
                      icon={Check}
                      disabled={full || busy !== null}
                      loading={busy === `${r.id}:approve`}
                      title={full ? "No positions remain on this task" : undefined}
                      onClick={() => review(r, { action: "approve" })}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={X}
                      disabled={busy !== null}
                      onClick={() => {
                        setReason("");
                        setDialogError(null);
                        setRejecting(r);
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {decided.length > 0 && (
          <details className="border-t border-line px-5 py-3 text-sm">
            <summary className="font-medium text-muted hover:text-ink">Recent decisions</summary>
            <ul className="mt-2 space-y-1.5">
              {decided.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 text-muted">
                    <span className="text-ink">{r.memberName}</span> · {r.taskTitle}
                    {r.reviewedByName && ` · by ${r.reviewedByName}`}
                    {r.status === "rejected" && r.reviewNote && ` · ${r.reviewNote}`}
                  </span>
                  <Badge tone={STATUS_TONES[r.status]}>{VOLUNTEER_REQUEST_STATUS_LABELS[r.status]}</Badge>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Dialog open={rejecting !== null} onClose={() => setRejecting(null)} title="Reject request" description={rejecting ? `${rejecting.memberName} · ${rejecting.taskTitle}` : undefined}>
        {rejecting && (
          <div className="space-y-4 text-sm">
            <FormError message={dialogError} />
            <TextAreaField
              label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              hint="The member sees this. The position stays open for someone else."
              optional
              autoFocus
            />
            <DialogActions>
              <Button variant="secondary" onClick={() => setRejecting(null)}>
                Cancel
              </Button>
              <Button variant="danger" icon={X} loading={busy === `${rejecting.id}:reject`} onClick={() => review(rejecting, { action: "reject", reason: reason.trim() || null })}>
                Reject request
              </Button>
            </DialogActions>
          </div>
        )}
      </Dialog>
    </>
  );
}
