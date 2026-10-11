"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, HandHeart, Home, IdCard, ListChecks, LogOut, Megaphone, Package, Receipt, ShoppingBag, UserRound, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "@/lib/api-client";
import { cart } from "@/lib/cart";
import { Logo } from "./public-shell";
import { useSession } from "./session";
import { cn } from "./ui";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

/** Add a member page here and it appears in the member navigation. */
export const MEMBER_NAV: NavItem[] = [
  { href: "/member", label: "Dashboard", icon: Home, exact: true },
  { href: "/member/membership", label: "My membership", icon: IdCard },
  { href: "/member/events", label: "Events and tickets", icon: CalendarDays },
  { href: "/shop", label: "Merchandise", icon: ShoppingBag },
  { href: "/member/orders", label: "My orders", icon: Package },
  { href: "/member/tasks", label: "My tasks", icon: ListChecks },
  { href: "/member/volunteering", label: "Volunteer", icon: HandHeart },
  { href: "/member/claims", label: "Expense claims", icon: Receipt },
  { href: "/member/announcements", label: "Announcements", icon: Megaphone },
  { href: "/member/profile", label: "Profile", icon: UserRound },
];

/** Header and navigation for signed-in members. */
export function MemberShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const user = useSession();
  const [leaving, setLeaving] = useState(false);

  async function signOut() {
    setLeaving(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      // The cart belongs to the account that is leaving; the next person must not find it.
      cart.clear();
      // A full page load on purpose: it drops all client state held for the old session.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/login");
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="no-print sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="page-shell flex h-16 items-center justify-between gap-4">
          <Link href="/member" aria-label="Skyline member home" className="rounded-control">
            <Logo compact />
          </Link>
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0 text-right">
              <p className="truncate text-sm font-semibold text-ink">{user.name}</p>
              <p className="font-mono text-xs text-muted">{user.memberNo}</p>
            </div>
            <button
              type="button"
              onClick={signOut}
              disabled={leaving}
              aria-label="Sign out"
              title="Sign out"
              className="flex size-10 shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-ink"
            >
              <LogOut className="size-4" aria-hidden />
            </button>
          </div>
        </div>
        <nav aria-label="Member" className="no-scrollbar page-shell flex gap-1 overflow-x-auto pb-2">
          {MEMBER_NAV.map((item) => {
            const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 shrink-0 items-center gap-2 rounded-control px-3 text-sm font-medium transition-colors",
                  active ? "bg-brand-soft text-brand-deep" : "text-muted hover:bg-sunken hover:text-ink",
                )}
              >
                <item.icon className="size-4" aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main id="main" className="page-shell flex-1 py-(--page-space)">
        {children}
      </main>
    </div>
  );
}
