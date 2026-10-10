import { publicRoute } from "@/server/http";
import { listPublicAnnouncements } from "@/server/services/announcements";

/** Announcements addressed to everyone. Member-only posts are not included. */
export const GET = publicRoute({}, () => listPublicAnnouncements());
