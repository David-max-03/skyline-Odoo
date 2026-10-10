import type {
  Announcement,
  AnnouncementAudience,
  AnnouncementInput,
  PublicAnnouncement,
  SessionUser,
} from "@/lib/contracts";
import { all, get, newId, nowIso, run } from "../db";
import { notFound, requireRole } from "../errors";

/**
 * Announcements are posted once and kept as a dated record. Skyline does not
 * send email or chat messages; nothing here claims that it does.
 */

interface Row {
  id: string;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  published_at: string;
  author_name: string | null;
}

const SELECT = `
  SELECT a.*, u.name AS author_name
  FROM announcements a LEFT JOIN users u ON u.id = a.created_by`;

const toAnnouncement = (r: Row): Announcement => ({
  id: r.id,
  title: r.title,
  body: r.body,
  audience: r.audience,
  authorName: r.author_name,
  publishedAt: r.published_at,
});

export function listAnnouncements(): Announcement[] {
  return all<Row>(`${SELECT} ORDER BY a.published_at DESC`).map(toAnnouncement);
}

/** The public news board shows only posts addressed to everyone. */
export function listPublicAnnouncements(): PublicAnnouncement[] {
  return all<Row>(`${SELECT} WHERE a.audience = 'everyone' ORDER BY a.published_at DESC LIMIT 50`).map(
    (r) => ({ id: r.id, title: r.title, body: r.body, publishedAt: r.published_at }),
  );
}

/** What a signed-in member reads: public posts and member-only ones, without author details. */
export function listMemberAnnouncements(): (PublicAnnouncement & { membersOnly: boolean })[] {
  return all<Row>(`${SELECT} ORDER BY a.published_at DESC LIMIT 50`).map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    publishedAt: r.published_at,
    membersOnly: r.audience === "members",
  }));
}

export function createAnnouncement(input: AnnouncementInput, actor: SessionUser | null): Announcement {
  const user = requireRole(actor, "admin", "organizer");
  const id = newId("ann");
  run(
    "INSERT INTO announcements (id, title, body, audience, created_by, published_at) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    input.title,
    input.body,
    input.audience,
    user.id,
    nowIso(),
  );
  return toAnnouncement(get<Row>(`${SELECT} WHERE a.id = ?`, id)!);
}

export function deleteAnnouncement(id: string, actor: SessionUser | null): void {
  requireRole(actor, "admin", "organizer");
  if (run("DELETE FROM announcements WHERE id = ?", id).changes !== 1) throw notFound("Announcement");
}
