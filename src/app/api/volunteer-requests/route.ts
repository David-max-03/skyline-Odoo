import { CAN } from "@/lib/contracts";
import { staffRoute } from "@/server/http";
import { listVolunteerRequests } from "@/server/services/volunteering";

/** Members' requests to volunteer, those awaiting a decision first. President and organizers only. */
export const GET = staffRoute(CAN.reviewVolunteers, {}, ({ user }) => listVolunteerRequests(user));
