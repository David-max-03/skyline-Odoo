import { CAN, announcementInputSchema } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { createAnnouncement, listAnnouncements } from "@/server/services/announcements";

export const GET = staffRoute(null, {}, () => listAnnouncements());

export const POST = staffRoute(
  CAN.manageAnnouncements,
  { body: announcementInputSchema },
  ({ body, user }) => createAnnouncement(body, user),
);
