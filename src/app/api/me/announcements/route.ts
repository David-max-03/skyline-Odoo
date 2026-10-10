import { memberRoute } from "@/server/http";
import { listMemberAnnouncements } from "@/server/services/announcements";

/** Club announcements, including the member-only ones. */
export const GET = memberRoute({}, () => listMemberAnnouncements());
