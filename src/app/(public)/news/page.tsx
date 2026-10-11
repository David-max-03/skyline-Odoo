"use client";

import { Megaphone } from "lucide-react";
import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api-client";
import type { PublicAnnouncement } from "@/lib/contracts";
import { formatDateTime } from "@/lib/dates";

export default function NewsPage() {
  const { data, error, reload } = useApi<PublicAnnouncement[]>("/api/public/announcements");

  return (
    <>
      <PageHeader title="News" description="Announcements from the committee, newest first. This board is the record of what was said and when." />
      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : !data ? (
        <div className="space-y-4" role="status" aria-label="Loading announcements">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : data.length === 0 ? (
        <Card>
          <EmptyState icon={Megaphone} title="No announcements yet" />
        </Card>
      ) : (
        <ol className="grid gap-4 xl:grid-cols-2">
          {data.map((post) => (
            <li key={post.id}>
              <Card className="h-full p-5">
                <article>
                  <p className="text-[0.8125rem] text-muted">
                    <time dateTime={post.publishedAt}>{formatDateTime(post.publishedAt)}</time>
                  </p>
                  <h2 className="mt-1 text-lg font-bold">{post.title}</h2>
                  <p className="mt-2 max-w-prose whitespace-pre-line text-sm leading-relaxed">{post.body}</p>
                </article>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
