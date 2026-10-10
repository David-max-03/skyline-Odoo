"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { OrgShell } from "@/components/org-shell";
import { SessionProvider } from "@/components/session";
import { ErrorState, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api-client";
import type { SessionUser } from "@/lib/contracts";

/** Every /org page: resolve the session, then render inside the staff shell. */
export default function OrgLayout({ children }: { children: ReactNode }) {
  const me = useApi<{ user: SessionUser | null }>("/api/auth/me");
  const router = useRouter();
  const pathname = usePathname();
  const signedOut = me.data !== null && me.data.user === null;
  // Members have their own area. The API refuses them here regardless.
  const isMember = me.data?.user?.role === "member";

  useEffect(() => {
    if (signedOut) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    if (isMember) router.replace("/member");
  }, [signedOut, isMember, router, pathname]);

  if (me.error && !me.data) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <ErrorState message={me.error.message} onRetry={me.reload} />
      </div>
    );
  }

  if (!me.data?.user || isMember) {
    return (
      <div role="status" className="flex min-h-dvh items-center justify-center">
        <span className="sr-only">Loading your workspace…</span>
        <Skeleton className="h-10 w-40" />
      </div>
    );
  }

  return (
    <SessionProvider user={me.data.user}>
      <OrgShell>{children}</OrgShell>
    </SessionProvider>
  );
}
