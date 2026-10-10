import type { Metadata } from "next";
import type { ReactNode } from "react";

// The address of this page contains a one-time secret, so it must not be
// indexed or passed to other sites in a Referer header.
export const metadata: Metadata = {
  title: "Set your password · Skyline",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function ActivateLayout({ children }: { children: ReactNode }) {
  return children;
}
