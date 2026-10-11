"use client";

import { Camera, Check, ImagePlus, Receipt, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Money } from "./domain";
import { Dialog, DialogActions, useToast } from "./overlay";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  FormError,
  LoadingBlock,
  Notice,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
  type Tone,
} from "./ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import {
  CATEGORY_LABELS,
  CLAIM_CATEGORIES,
  CLAIM_STATUS_LABELS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type ClaimList,
  type ClaimantOption,
  type ClaimStatus,
  type ExpenseClaim,
  type PaymentMethod,
} from "@/lib/contracts";
import { formatDate, formatShortDateTime, ymdInTz } from "@/lib/dates";
import { CURRENCY, parseMoney } from "@/lib/money";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const SYMBOL =
  new Intl.NumberFormat("en", { style: "currency", currency: CURRENCY }).formatToParts(0).find((p) => p.type === "currency")
    ?.value ?? "";

const STATUS_TONE: Record<ClaimStatus, Tone> = {
  submitted: "neutral",
  under_review: "brand",
  approved: "warn",
  rejected: "bad",
  paid: "ok",
};

export function ClaimStatusBadge({ status }: { status: ClaimStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{CLAIM_STATUS_LABELS[status]}</Badge>;
}

/**
 * Receipt photo picker: take a photo or choose one, see it, and swap or remove
 * it before sending. The server decides whether the file is acceptable.
 */
function PhotoField({ file, onFile, error }: { file: File | null; onFile: (file: File | null) => void; error?: string }) {
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);

  /** Swaps the chosen file and its local preview together, releasing the old preview. */
  const choose = (next: File | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = next ? URL.createObjectURL(next) : null;
    setPreview(previewRef.current);
    onFile(next);
  };

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  const pick = (event: { target: HTMLInputElement }) => {
    choose(event.target.files?.[0] ?? null);
    event.target.value = ""; // so choosing the same file again still fires
  };

  return (
    <div role="group" aria-labelledby="receipt-label">
      <p id="receipt-label" className="mb-1.5 text-[0.8125rem] font-medium text-ink">
        Photo of the receipt
      </p>
      <input ref={camera} type="file" accept="image/*" capture="environment" onChange={pick} className="sr-only" tabIndex={-1} aria-hidden />
      <input ref={library} type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} className="sr-only" tabIndex={-1} aria-hidden />
      {preview && file ? (
        <div className="rounded-control border border-line bg-sunken p-2">
          {/* A local preview of the chosen file; nothing has been uploaded yet. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="The receipt photo you chose" className="mx-auto max-h-64 rounded object-contain" />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 truncate text-[0.8125rem] text-muted">
              {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" icon={ImagePlus} onClick={() => library.current?.click()}>
                Replace
              </Button>
              <Button size="sm" variant="danger" icon={Trash2} onClick={() => choose(null)}>
                Remove
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 rounded-control border border-dashed border-line-strong p-3">
          <Button variant="secondary" icon={Camera} onClick={() => camera.current?.click()}>
            Take a photo
          </Button>
          <Button variant="secondary" icon={ImagePlus} onClick={() => library.current?.click()}>
            Choose a photo
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-1.5 text-[0.8125rem] text-bad">
          {error}
        </p>
      ) : (
        <p className="mt-1.5 text-[0.8125rem] text-muted">Required. JPEG, PNG or WebP, up to 5 MB. Only you, the treasurer and the president can see it.</p>
      )}
    </div>
  );
}

function ClaimForm({
  onSaved,
  onCancel,
  canFileForOthers = false,
}: {
  onSaved: (claim: ExpenseClaim) => void;
  onCancel: () => void;
  /** President only: offer to file the claim for a committee member or volunteer. */
  canFileForOthers?: boolean;
}) {
  // "kind:id" of the person the claim is for; empty means the signed-in account.
  const [claimant, setClaimant] = useState("");
  const claimants = useApi<ClaimantOption[]>(canFileForOthers ? "/api/claims/claimants" : null);
  const [values, setValues] = useState({
    title: "",
    amount: "",
    spentOn: ymdInTz(new Date()),
    category: "supplies",
    justification: "",
    notes: "",
  });
  const [photo, setPhoto] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const cents = parseMoney(values.amount);
    const problems: Record<string, string> = {};
    if (cents === null || cents <= 0) problems.amountCents = "Enter the amount you paid";
    if (!photo) problems.evidence = "A photo of the receipt or bill is required";
    else if (photo.size > MAX_IMAGE_BYTES) problems.evidence = "The image must be 5 MB or smaller";
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const form = new FormData();
      form.set("title", values.title);
      form.set("amountCents", String(cents));
      form.set("spentOn", values.spentOn);
      form.set("category", values.category);
      form.set("justification", values.justification);
      form.set("notes", values.notes);
      form.set("evidence", photo!);
      if (claimant) {
        const [kind, id] = claimant.split(":");
        form.set("claimantKind", kind);
        form.set("claimantId", id);
      }
      onSaved(await api<ExpenseClaim>("/api/claims", { method: "POST", form }));
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <FormError message={formError} />
      {canFileForOthers && (
        <SelectField
          label="Who is this claim for?"
          value={claimant}
          onChange={(e) => setClaimant(e.target.value)}
          error={errors.claimantId ?? errors.claimantKind}
          hint={
            claimants.error
              ? "The list of people could not be loaded. You can still file a claim for yourself."
              : claimant
                ? "They are recorded as the claimant and you as the person who filed it. The treasurer reviews it; you cannot approve a claim you filed."
                : "Choose a committee member or volunteer to file it on their behalf."
          }
        >
          <option value="">Myself</option>
          {(["staff", "member"] as const).map((kind) => {
            const people = (claimants.data ?? []).filter((p) => p.kind === kind);
            return people.length === 0 ? null : (
              <optgroup key={kind} label={kind === "staff" ? "Committee" : "Volunteers"}>
                {people.map((p) => (
                  <option key={p.id} value={`${p.kind}:${p.id}`}>
                    {p.name} · {p.detail}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </SelectField>
      )}
      <TextField label={claimant ? "What did they buy?" : "What did you buy?"} value={values.title} onChange={set("title")} error={errors.title} placeholder="Balloons and tape" required autoFocus />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField label="Amount" prefix={SYMBOL} inputMode="decimal" value={values.amount} onChange={set("amount")} error={errors.amountCents} placeholder="450" required />
        <TextField label="Date you paid" type="date" max={ymdInTz(new Date())} value={values.spentOn} onChange={set("spentOn")} error={errors.spentOn} required />
        <SelectField label="Category" value={values.category} onChange={set("category")} error={errors.category}>
          {CLAIM_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </SelectField>
      </div>
      <TextAreaField
        label="Why was it needed?"
        value={values.justification}
        onChange={set("justification")}
        error={errors.justification}
        hint="Which event or job it was for, and who asked you to buy it."
        required
      />
      <PhotoField file={photo} onFile={setPhoto} error={errors.evidence} />
      <TextAreaField label="Anything else?" value={values.notes} onChange={set("notes")} error={errors.notes} optional />
      <DialogActions>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          Send claim
        </Button>
      </DialogActions>
    </form>
  );
}

type ReviewBody =
  | { action: "start_review" }
  | { action: "approve"; note: string | null }
  | { action: "reject"; reason: string }
  | { action: "pay"; method: PaymentMethod };

function ClaimDetail({ claim, canReview, onChanged }: { claim: ExpenseClaim; canReview: boolean; onChanged: (claim: ExpenseClaim, message: string) => void }) {
  const [mode, setMode] = useState<"view" | "reject">("view");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("upi");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const reviewable = canReview && !claim.isMine && !claim.filedByMe;
  const open = claim.status === "submitted" || claim.status === "under_review";

  async function send(body: ReviewBody, message: string) {
    setWorking(body.action);
    setFormError(null);
    setErrors({});
    try {
      onChanged(await api<ExpenseClaim>(`/api/claims/${claim.id}`, { method: "POST", body }), message);
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-xl font-bold text-ink">{claim.title}</p>
          <p className="text-muted">
            {claim.claimantName}
            {claim.filedByName && ` (filed by ${claim.filedByName})`} · {CATEGORY_LABELS[claim.category]} · paid {formatDate(claim.spentOn)}
          </p>
        </div>
        <div className="text-right">
          <p className="font-display text-xl font-bold text-ink">
            <Money cents={claim.amountCents} />
          </p>
          <ClaimStatusBadge status={claim.status} />
        </div>
      </div>

      <dl className="space-y-3">
        <div>
          <dt className="text-muted">Why it was needed</dt>
          <dd className="whitespace-pre-line text-ink">{claim.justification}</dd>
        </div>
        {claim.notes && (
          <div>
            <dt className="text-muted">Notes</dt>
            <dd className="whitespace-pre-line text-ink">{claim.notes}</dd>
          </div>
        )}
        {claim.reviewedByName && (
          <div>
            <dt className="text-muted">Reviewed by</dt>
            <dd className="text-ink">
              {claim.reviewedByName}
              {claim.reviewedAt && `, ${formatShortDateTime(claim.reviewedAt)}`}
            </dd>
          </div>
        )}
      </dl>

      {claim.status === "rejected" && (
        <Notice tone="bad" title="Rejected">
          {claim.reviewNote}
        </Notice>
      )}
      {claim.status !== "rejected" && claim.reviewNote && <Notice tone="neutral">{claim.reviewNote}</Notice>}

      <div>
        <p className="mb-1.5 text-[0.8125rem] font-medium text-ink">Receipt</p>
        {imageFailed ? (
          <p className="rounded-control border border-dashed border-line-strong px-3 py-3 text-muted">The receipt photo could not be loaded.</p>
        ) : (
          <a href={`/api/files/${claim.evidenceFileId}`} target="_blank" rel="noreferrer" className="block rounded-control border border-line bg-sunken p-2">
            {/* Private image behind the session cookie: next/image cannot optimise or cache it. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/files/${claim.evidenceFileId}`}
              alt={`Receipt for ${claim.title}`}
              onError={() => setImageFailed(true)}
              className="mx-auto max-h-80 rounded object-contain"
            />
          </a>
        )}
      </div>

      {canReview && claim.isMine && claim.status !== "paid" && claim.status !== "rejected" && (
        <Notice tone="neutral">This is your own claim, so the other reviewer has to approve and pay it.</Notice>
      )}
      {canReview && claim.filedByMe && claim.status !== "paid" && claim.status !== "rejected" && (
        <Notice tone="neutral">You filed this claim for {claim.claimantName}, so the other reviewer has to approve and pay it.</Notice>
      )}

      {reviewable && open && mode === "view" && (
        <>
          <TextAreaField label="Note to the claimant" value={note} onChange={(e) => setNote(e.target.value)} error={errors.note} optional />
          <p className="text-[0.8125rem] text-muted">
            Approving adds one unpaid expense of <Money cents={claim.amountCents} /> to the ledger. It is not paid until you record the payment.
          </p>
          <DialogActions>
            {claim.status === "submitted" && (
              <Button variant="secondary" loading={working === "start_review"} onClick={() => send({ action: "start_review" }, "Marked as under review.")}>
                Mark under review
              </Button>
            )}
            <Button variant="secondary" icon={X} onClick={() => setMode("reject")}>
              Reject
            </Button>
            <Button icon={Check} loading={working === "approve"} onClick={() => send({ action: "approve", note: note.trim() || null }, "Claim approved and added to the ledger as unpaid.")}>
              Approve
            </Button>
          </DialogActions>
        </>
      )}

      {reviewable && open && mode === "reject" && (
        <>
          <TextAreaField label="Why is this being rejected?" value={reason} onChange={(e) => setReason(e.target.value)} error={errors.reason} hint="The claimant sees this." autoFocus />
          <DialogActions>
            <Button variant="secondary" onClick={() => setMode("view")}>
              Back
            </Button>
            <Button variant="danger" icon={X} loading={working === "reject"} onClick={() => send({ action: "reject", reason }, "Claim rejected.")}>
              Reject claim
            </Button>
          </DialogActions>
        </>
      )}

      {reviewable && claim.status === "approved" && (
        <div className="rounded-control border border-line bg-sunken px-3.5 py-3">
          <p className="font-medium text-ink">Record the payment</p>
          <p className="text-[0.8125rem] text-muted">Do this only after the money has actually been handed over or sent.</p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <SelectField label="Paid by" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} error={errors.method} className="w-44">
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </SelectField>
            <Button icon={Check} loading={working === "pay"} onClick={() => send({ action: "pay", method }, "Payment recorded. The claim is paid.")}>
              Mark as paid
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The claims screen for both committee accounts and members. The server decides what each sees. */
export function ClaimsBoard({ description }: { description: string }) {
  const toast = useToast();
  const { data, error, reload } = useApi<ClaimList>("/api/claims");
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<ExpenseClaim | null>(null);

  const newClaim = data?.canSubmit ? (
    <Button icon={Receipt} onClick={() => setAdding(true)}>
      New claim
    </Button>
  ) : null;

  return (
    <>
      <PageHeader title="Expense claims" description={description} actions={newClaim} />

      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : !data ? (
        <Card>
          <LoadingBlock label="Loading claims" />
        </Card>
      ) : (
        <>
          {!data.canSubmit && data.reason && (
            <Notice tone="neutral" className="mb-5">
              {data.reason}
            </Notice>
          )}
          {data.claims.length === 0 ? (
            <Card>
              <EmptyState
                icon={Receipt}
                title={data.canReview ? "No claims to review" : "No claims yet"}
                description={data.canSubmit ? "Paid for something for the club? File a claim with a photo of the receipt." : "Claims you file will show here."}
                action={newClaim}
              />
            </Card>
          ) : (
            <ul className="space-y-3">
              {data.claims.map((claim) => (
                <li key={claim.id}>
                  <button
                    type="button"
                    onClick={() => setViewing(claim)}
                    className="flex w-full flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-5 text-left shadow-card transition-colors hover:border-brand-line"
                  >
                    <span className="min-w-0">
                      <span className="block text-[0.9375rem] font-semibold text-ink">{claim.title}</span>
                      <span className="block text-[0.8125rem] text-muted">
                        {data.canReview && `${claim.claimantName}${claim.isMine ? " (you)" : ""} · `}
                        {claim.filedByName && `filed by ${claim.filedByName} · `}
                        {CATEGORY_LABELS[claim.category]} · paid {formatDate(claim.spentOn)} · <span className="font-mono">{claim.code}</span>
                      </span>
                      {claim.status === "rejected" && claim.reviewNote && <span className="mt-1 block text-[0.8125rem] text-bad">{claim.reviewNote}</span>}
                    </span>
                    <span className="flex items-center gap-3">
                      <Money cents={claim.amountCents} className="font-display text-lg font-bold text-ink" />
                      <ClaimStatusBadge status={claim.status} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <Dialog open={adding} onClose={() => setAdding(false)} title="New expense claim" description="A photo of the receipt is required." size="lg">
        {adding && (
          <ClaimForm
            canFileForOthers={data?.canFileForOthers ?? false}
            onCancel={() => setAdding(false)}
            onSaved={(claim) => {
              setAdding(false);
              toast.success(
                claim.filedByMe
                  ? `Claim ${claim.code} filed for ${claim.claimantName} and sent to the treasurer.`
                  : `Claim ${claim.code} sent to the treasurer.`,
              );
              reload();
            }}
          />
        )}
      </Dialog>

      <Dialog open={viewing !== null} onClose={() => setViewing(null)} title="Expense claim" description={viewing?.code} size="lg">
        {viewing && (
          <ClaimDetail
            key={`${viewing.id}-${viewing.status}`}
            claim={viewing}
            canReview={data?.canReview ?? false}
            onChanged={(claim, message) => {
              toast.success(message);
              setViewing(claim);
              reload();
            }}
          />
        )}
      </Dialog>
    </>
  );
}
