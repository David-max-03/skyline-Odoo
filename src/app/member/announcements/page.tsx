"use client";

import { Megaphone } from "lucide-react";
import { Badge, Card, EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api-client";
import type { PublicAnnouncement } from "@/lib/contracts";
import { formatDateTime } from "@/lib/dates";

type MemberAnnouncement = PublicAnnouncement & { membersOnly: boolean };

export default function MemberAnnouncementsPage() {
  const { data, error, reload } = useApi<MemberAnnouncement[]>("/api/me/announcements");
  return (
    <>
      <PageHeader title="Announcements" description="News from the committee, including posts only members can see." />
      {error && !data ? (
        <Card>
          <ErrorState message={error.message} onRetry={reload} />
        </Card>
      ) : !data ? (
        <Card>
          <LoadingBlock label="Loading announcements" />
        </Card>
      ) : data.length === 0 ? (
        <Card>
          <EmptyState icon={Megaphone} title="Nothing posted yet" description="Announcements from the committee will show here." />
        </Card>
      ) : (
        <ul className="space-y-4">
          {data.map((a) => (
            <li key={a.id}>
              <Card className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[0.9375rem] font-semibold">{a.title}</h2>
                  {a.membersOnly && <Badge tone="brand">Members only</Badge>}
                </div>
                <p className="mt-0.5 text-[0.8125rem] text-muted">{formatDateTime(a.publishedAt)}</p>
                <p className="mt-3 whitespace-pre-line text-sm leading-relaxed">{a.body}</p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
