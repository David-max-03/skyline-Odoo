"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { MemberShell } from "@/components/member-shell";
import { SessionProvider } from "@/components/session";
import { ErrorState, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api-client";
import type { SessionUser } from "@/lib/contracts";

/** Every /member page: resolve the session, then render inside the member shell. */
export default function MemberLayout({ children }: { children: ReactNode }) {
  const me = useApi<{ user: SessionUser | null }>("/api/auth/me");
  const router = useRouter();
  const pathname = usePathname();
  const user = me.data?.user ?? null;
  const signedOut = me.data !== null && user === null;
  // Committee accounts have their own area. The member API refuses them here regardless.
  const isStaff = user !== null && user.role !== "member";

  useEffect(() => {
    if (signedOut) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    if (isStaff) router.replace("/org");
  }, [signedOut, isStaff, router, pathname]);

  if (me.error && !me.data) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <ErrorState message={me.error.message} onRetry={me.reload} />
      </div>
    );
  }

  if (!user || isStaff) {
    return (
      <div role="status" className="flex min-h-dvh items-center justify-center">
        <span className="sr-only">Loading your account…</span>
        <Skeleton className="h-10 w-40" />
      </div>
    );
  }

  return (
    <SessionProvider user={user}>
      <MemberShell>{children}</MemberShell>
    </SessionProvider>
  );
}
