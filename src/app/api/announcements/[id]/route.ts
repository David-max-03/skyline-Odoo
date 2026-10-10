import { CAN } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { deleteAnnouncement } from "@/server/services/announcements";

export const DELETE = staffRoute(CAN.manageAnnouncements, {}, ({ params, user }) => {
  deleteAnnouncement(params.id, user);
  return { ok: true };
});
