import { publicRoute } from "@/server/http";
import { paymentInstructions } from "@/server/services/applications";

/** The membership fee and, when the club's UPI ID is configured, a QR code that requests it. */
export const GET = publicRoute({}, () => paymentInstructions());
