"use client";

import { Copy, ExternalLink, Info, Megaphone, Send, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ConfirmDialog, useToast } from "@/components/overlay";
import { useCan } from "@/components/session";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  FormError,
  LinkButton,
  LoadingBlock,
  Notice,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/ui";
import { api, errorMessage, fieldErrors, useApi } from "@/lib/api-client";
import type { Announcement, Member } from "@/lib/contracts";
import { formatDateTime } from "@/lib/dates";

export default function AnnouncementsPage() {
  const toast = useToast();
  const canPost = useCan("manageAnnouncements");
  const canSeeMembers = useCan("manageMembers");
  const posts = useApi<Announcement[]>("/api/announcements");
  const [values, setValues] = useState({ title: "", body: "", audience: "everyone" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [deleting, setDeleting] = useState<Announcement | null>(null);
  const [copying, setCopying] = useState(false);

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function publish(e: FormEvent) {
    e.preventDefault();
    setPosting(true);
    setFormError(null);
    setErrors({});
    try {
      await api("/api/announcements", { method: "POST", body: values });
      toast.success(
        values.audience === "everyone"
          ? "Posted to the public news board. No email was sent."
          : "Saved as a members-only announcement. No email was sent.",
      );
      setValues({ title: "", body: "", audience: values.audience });
      posts.reload();
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
    } finally {
      setPosting(false);
    }
  }

  async function copyMailingList() {
    setCopying(true);
    try {
      const members = await api<Member[]>("/api/members");
      const emails = members.filter((m) => m.status === "active" || m.status === "expiring").map((m) => m.email);
      if (emails.length === 0) {
        toast.error("There are no active members to email yet.");
        return;
      }
      await navigator.clipboard.writeText(emails.join(", "));
      toast.success(`${emails.length} active member emails copied. Paste them into BCC in your mail app.`);
    } catch (error) {
      toast.error(error instanceof DOMException ? "The browser blocked copying. Try again from a secure page." : errorMessage(error));
    } finally {
      setCopying(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    try {
      await api(`/api/announcements/${deleting.id}`, { method: "DELETE" });
      toast.success("Announcement removed.");
      setDeleting(null);
      posts.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <>
      <PageHeader
        title="Announcements"
        description="Write it once. It goes on the news board with a date, so there is a record of what was said and when."
        actions={
          <LinkButton href="/news" target="_blank" variant="secondary" icon={ExternalLink}>
            Public news board
          </LinkButton>
        }
      />

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-2">
          {canPost ? (
            <Card>
              <CardHeader title="New announcement" />
              <form onSubmit={publish} noValidate className="space-y-4 p-5">
                <FormError message={formError} />
                <TextField label="Headline" value={values.title} onChange={set("title")} error={errors.title} placeholder="General meeting moved to Thursday" required />
                <TextAreaField label="Message" rows={6} value={values.body} onChange={set("body")} error={errors.body} required />
                <SelectField
                  label="Who is it for?"
                  value={values.audience}
                  onChange={set("audience")}
                  error={errors.audience}
                  hint={values.audience === "everyone" ? "Shown on the public news board." : "Kept off the public board; visible to the committee here."}
                >
                  <option value="everyone">Everyone</option>
                  <option value="members">Members only</option>
                </SelectField>
                <Button type="submit" icon={Send} loading={posting}>
                  Post announcement
                </Button>
              </form>
            </Card>
          ) : (
            <Notice tone="neutral" icon={Info}>
              Your role can read announcements. The president and event handlers can post them.
            </Notice>
          )}

          {/* Member addresses are member records: the president and the treasurer only. */}
          {canSeeMembers && (
            <Card className="p-5">
              <h2 className="text-[0.9375rem] font-semibold">Reaching members by email</h2>
              <p className="mt-1 text-sm text-muted">
                Skyline does not send email. Copy the active members&rsquo; addresses and paste them into BCC in your own mail app.
              </p>
              <Button variant="secondary" icon={Copy} className="mt-3" loading={copying} onClick={copyMailingList}>
                Copy member emails
              </Button>
            </Card>
          )}
        </div>

        <Card className="lg:col-span-3">
          <CardHeader title="Posted" description="Newest first." />
          {posts.error && !posts.data ? (
            <ErrorState message={posts.error.message} onRetry={posts.reload} />
          ) : !posts.data ? (
            <LoadingBlock label="Loading announcements" />
          ) : posts.data.length === 0 ? (
            <EmptyState icon={Megaphone} title="Nothing posted yet" description="Your first announcement will appear here and on the news board." />
          ) : (
            <ol>
              {posts.data.map((post) => (
                <li key={post.id} className="border-b border-line px-5 py-4 last:border-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[0.9375rem] font-semibold">{post.title}</h3>
                      <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[0.8125rem] text-muted">
                        <time dateTime={post.publishedAt}>{formatDateTime(post.publishedAt)}</time>
                        {post.authorName && <span>· {post.authorName}</span>}
                        <Badge tone={post.audience === "everyone" ? "brand" : "neutral"}>
                          {post.audience === "everyone" ? "Public" : "Members only"}
                        </Badge>
                      </p>
                    </div>
                    {canPost && (
                      <button
                        type="button"
                        onClick={() => setDeleting(post)}
                        aria-label={`Delete ${post.title}`}
                        className="flex size-9 shrink-0 items-center justify-center rounded-control text-subtle hover:bg-bad-soft hover:text-bad"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </button>
                    )}
                  </div>
                  <p className="mt-2 whitespace-pre-line text-sm">{post.body}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title="Remove this announcement?"
        confirmLabel="Remove"
        danger
      >
        <p>“{deleting?.title}” will disappear from the news board. People who already read it are not notified.</p>
      </ConfirmDialog>
    </>
  );
}
