"use client";

import { Check, CircleAlert, Copy, Hourglass, ImageOff, KeyRound, X } from "lucide-react";
import { useState } from "react";
import { Money } from "./domain";
import { Dialog, DialogActions, useToast } from "./overlay";
import { Badge, Button, Card, CardHeader, CheckboxField, ErrorState, FormError, Notice, TableSkeleton, TextAreaField } from "./ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import {
  APPLICATION_METHOD_LABELS,
  type ApplicationReview,
  type MembershipApplication,
  type SetupLink,
} from "@/lib/contracts";
import { formatDateTime, formatShortDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

/**
 * Shows a password-setup link to the staff member who just created it. The
 * link is not stored anywhere readable, so this is the only time it is seen.
 */
export function SetupLinkDialog({ link, onClose }: { link: SetupLink | null; onClose: () => void }) {
  const toast = useToast();
  const url = link && typeof window !== "undefined" ? `${window.location.origin}${link.path}` : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied.");
    } catch {
      toast.error("Could not copy. Select the link and copy it by hand.");
    }
  }

  return (
    <Dialog open={link !== null} onClose={onClose} title="Password setup link" description={link ? `For ${link.name} · ${link.memberNo}` : undefined}>
      {link && (
        <div className="space-y-4 text-sm">
          <Notice tone="warn" icon={CircleAlert} title="Send this to the member yourself">
            Skyline does not send email. Pass the link to {link.name.split(" ")[0]} privately ({link.email}). It is shown only now.
          </Notice>
          <div>
            <label htmlFor="setup-link" className="mb-1.5 block text-[0.8125rem] font-medium text-ink">
              One-time link
            </label>
            <div className="flex gap-2">
              <input
                id="setup-link"
                readOnly
                value={url}
                onFocus={(e) => e.target.select()}
                className="h-10 min-w-0 flex-1 rounded-control border border-line-strong bg-sunken px-3 font-mono text-[0.8125rem] text-ink"
              />
              <Button variant="secondary" icon={Copy} onClick={copy}>
                Copy
              </Button>
            </div>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>Works once, then stops.</li>
            <li>Expires {formatDateTime(link.expiresAt)}.</li>
            <li>Creating another link for this member cancels this one.</li>
          </ul>
          <DialogActions>
            <Button onClick={onClose}>Done</Button>
          </DialogActions>
        </div>
      )}
    </Dialog>
  );
}

function ReviewForm({
  application,
  onReviewed,
  onCancel,
}: {
  application: MembershipApplication;
  onReviewed: (review: ApplicationReview) => void;
  onCancel: () => void;
}) {
  const [received, setReceived] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState<"approve" | "reject" | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  async function send(body: { action: "approve"; paymentReceived: true } | { action: "reject"; reason: string }) {
    setWorking(body.action);
    setFormError(null);
    setErrors({});
    try {
      onReviewed(await api<ApplicationReview>(`/api/applications/${application.id}`, { method: "POST", body }));
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="space-y-5 text-sm">
      <FormError message={formError} />
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className="text-muted">Applicant</dt>
          <dd className="font-medium text-ink">{application.name}</dd>
          <dd className="break-all text-muted">{application.email}</dd>
          {application.studentId && <dd className="text-muted">Student ID {application.studentId}</dd>}
          {application.phone && <dd className="text-muted">{application.phone}</dd>}
        </div>
        <div>
          <dt className="text-muted">Says they paid</dt>
          <dd className="font-medium text-ink">
            <Money cents={application.amountCents} /> by {APPLICATION_METHOD_LABELS[application.paymentMethod]}
          </dd>
          <dt className="mt-2 text-muted">{application.paymentMethod === "cash" ? "Paid to" : "Reference"}</dt>
          <dd className="break-all font-mono text-ink">{application.paymentReference}</dd>
          <dd className="mt-2 text-muted">Sent {formatDateTime(application.createdAt)}</dd>
        </div>
      </dl>

      <div>
        <p className="mb-1.5 text-[0.8125rem] font-medium text-ink">Payment screenshot</p>
        {application.evidenceFileId && !imageFailed ? (
          <a href={`/api/files/${application.evidenceFileId}`} target="_blank" rel="noreferrer" className="block rounded-control border border-line bg-sunken p-2">
            {/* Private, per-request image behind the session cookie: next/image cannot optimise or cache it. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/files/${application.evidenceFileId}`}
              alt={`Payment screenshot sent by ${application.name}`}
              onError={() => setImageFailed(true)}
              className="mx-auto max-h-80 rounded object-contain"
            />
          </a>
        ) : (
          <p className="flex items-center gap-2 rounded-control border border-dashed border-line-strong px-3 py-3 text-muted">
            <ImageOff className="size-4 shrink-0" aria-hidden />
            {imageFailed ? "The screenshot could not be loaded." : "No screenshot was sent (cash payment)."}
          </p>
        )}
        <p className="mt-1.5 text-[0.8125rem] text-muted">
          A screenshot can be edited or reused. Check the club&rsquo;s own account before approving.
        </p>
      </div>

      {rejecting ? (
        <>
          <TextAreaField
            label="Why is this being rejected?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={errors.reason}
            hint="The applicant sees this when they check their status."
            autoFocus
          />
          <DialogActions>
            <Button variant="secondary" onClick={() => setRejecting(false)}>
              Back
            </Button>
            <Button variant="danger" icon={X} loading={working === "reject"} onClick={() => send({ action: "reject", reason })}>
              Reject application
            </Button>
          </DialogActions>
        </>
      ) : (
        <>
          <div className="rounded-control border border-line bg-sunken px-3.5 py-3">
            <CheckboxField
              label={`I have checked the club's account and ${formatMoney(application.amountCents)} was received`}
              hint="Approving creates the member, records the dues as collected in the ledger, and gives you a password link to send."
              checked={received}
              onChange={(e) => setReceived(e.target.checked)}
            />
            {errors.paymentReceived && <p className="mt-2 text-[0.8125rem] text-bad">{errors.paymentReceived}</p>}
          </div>
          <DialogActions>
            <Button variant="secondary" onClick={onCancel}>
              Not now
            </Button>
            <Button variant="secondary" icon={X} onClick={() => setRejecting(true)}>
              Reject
            </Button>
            <Button icon={Check} disabled={!received} loading={working === "approve"} onClick={() => send({ action: "approve", paymentReceived: true })}>
              Approve and create member
            </Button>
          </DialogActions>
        </>
      )}
    </div>
  );
}

/** Membership applications awaiting a decision, with recent decisions beneath. */
export function ApplicationsPanel({ onMemberCreated }: { onMemberCreated: () => void }) {
  const toast = useToast();
  const { data, error, reload } = useApi<MembershipApplication[]>("/api/applications");
  const [reviewing, setReviewing] = useState<MembershipApplication | null>(null);
  const [link, setLink] = useState<SetupLink | null>(null);

  const pending = (data ?? []).filter((a) => a.status === "pending");
  const decided = (data ?? []).filter((a) => a.status !== "pending").slice(0, 5);

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
        <TableSkeleton label="Loading applications" rows={2} />
      </Card>
    );
  }
  if (data.length === 0) return null;

  return (
    <>
      <Card className="mb-6">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Applications to review
              {pending.length > 0 && <Badge tone="warn">{pending.length}</Badge>}
            </span>
          }
          description="People who say they have paid the membership fee. Nobody becomes a member until you confirm the money arrived."
        />
        {pending.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">Nothing is waiting for review.</p>
        ) : (
          <ul className="divide-y divide-line">
            {pending.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-ink">{a.name}</p>
                  <p className="truncate text-[0.8125rem] text-muted">
                    {a.email} · {APPLICATION_METHOD_LABELS[a.paymentMethod]} · <span className="font-mono">{a.paymentReference}</span>
                  </p>
                  <p className="text-[0.8125rem] text-muted">
                    <span className="font-mono">{a.code}</span> · sent {formatShortDateTime(a.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone="warn" icon={Hourglass}>
                    Unverified
                  </Badge>
                  <Button size="sm" onClick={() => setReviewing(a)}>
                    Review
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {decided.length > 0 && (
          <details className="border-t border-line px-5 py-3 text-sm">
            <summary className="font-medium text-muted hover:text-ink">Recent decisions</summary>
            <ul className="mt-2 space-y-1.5">
              {decided.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 text-muted">
                    <span className="text-ink">{a.name}</span>
                    {a.memberNo && <span className="font-mono"> · {a.memberNo}</span>}
                    {a.channel === "razorpay" && " · paid online"}
                    {a.reviewedByName && ` · by ${a.reviewedByName}`}
                    {a.reviewedAt && `, ${formatShortDateTime(a.reviewedAt)}`}
                    {a.status === "rejected" && a.reviewNote && ` · ${a.reviewNote}`}
                  </span>
                  {a.status === "approved" ? <Badge tone="ok">Approved</Badge> : <Badge tone="bad">Rejected</Badge>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Dialog open={reviewing !== null} onClose={() => setReviewing(null)} title="Review application" description={reviewing?.code} size="lg">
        {reviewing && (
          <ReviewForm
            key={reviewing.id}
            application={reviewing}
            onCancel={() => setReviewing(null)}
            onReviewed={(review) => {
              setReviewing(null);
              reload();
              if (review.setup) {
                toast.success(`${review.application.name} is now member ${review.application.memberNo}.`);
                setLink(review.setup);
                onMemberCreated();
              } else {
                toast.success(`Application from ${review.application.name} rejected.`);
              }
            }}
          />
        )}
      </Dialog>

      <SetupLinkDialog link={link} onClose={() => setLink(null)} />
    </>
  );
}

/** Button for the member record: creates a setup or reset link and shows it once. */
export function SetupLinkButton({ memberId, hasAccount }: { memberId: string; hasAccount: boolean }) {
  const toast = useToast();
  const [link, setLink] = useState<SetupLink | null>(null);
  const [working, setWorking] = useState(false);

  async function create() {
    setWorking(true);
    try {
      setLink(await api<SetupLink>(`/api/members/${memberId}/setup-link`, { method: "POST" }));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" icon={KeyRound} loading={working} onClick={create}>
        {hasAccount ? "Password reset link" : "Create setup link"}
      </Button>
      <SetupLinkDialog link={link} onClose={() => setLink(null)} />
    </>
  );
}
