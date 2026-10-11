"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  ExternalLink,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Megaphone,
  Menu,
  Receipt,
  ScanLine,
  Shirt,
  UserCog,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api-client";
import { cart } from "@/lib/cart";
import { ROLE_LABELS, can, type CAN } from "@/lib/contracts";
import { Logo } from "./public-shell";
import { useSession } from "./session";
import { cn } from "./ui";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  /** Shown only to roles with this permission. The server refuses the page's data to anyone else regardless. */
  needs?: keyof typeof CAN;
}

/** Add a staff page here and it appears in the sidebar and the mobile menu. */
export const ORG_NAV: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Overview",
    items: [
      { href: "/org", label: "Dashboard", icon: LayoutDashboard, exact: true },
    ],
  },
  {
    heading: "Run events",
    items: [
      { href: "/org/events", label: "Events", icon: CalendarDays },
      { href: "/org/check-in", label: "Check-in", icon: ScanLine },
      { href: "/org/tasks", label: "Volunteer tasks", icon: ListChecks },
    ],
  },
  {
    heading: "Club",
    items: [
      { href: "/org/finance", label: "Finance", icon: Wallet, needs: "manageFinance" },
      { href: "/org/claims", label: "Expense claims", icon: Receipt },
      { href: "/org/members", label: "Members", icon: Users, needs: "manageMembers" },
      { href: "/org/merch", label: "Merchandise", icon: Shirt, needs: "manageMerch" },
      { href: "/org/announcements", label: "Announcements", icon: Megaphone },
      { href: "/org/accounts", label: "Committee accounts", icon: UserCog, needs: "manageAccounts" },
    ],
  },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const user = useSession();
  const groups = ORG_NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.needs || can(user, item.needs)),
  })).filter((group) => group.items.length > 0);
  return (
    <nav aria-label="Committee" className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {groups.map((group) => (
        <div key={group.heading}>
          <p className="px-3 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-on-night-muted">
            {group.heading}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex h-10 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors",
                      active
                        ? "bg-night-raised text-white"
                        : "text-on-night-muted hover:bg-night-raised/60 hover:text-on-night",
                    )}
                  >
                    {active && <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />}
                    <item.icon className={cn("size-[1.125rem] shrink-0", active && "text-accent")} aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function AccountPanel() {
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
    <div className="border-t border-night-line p-3">
      <Link
        href="/"
        target="_blank"
        className="flex h-9 items-center gap-3 rounded-control px-3 text-[0.8125rem] font-medium text-on-night-muted hover:bg-night-raised/60 hover:text-on-night"
      >
        <ExternalLink className="size-4" aria-hidden />
        Public site
      </Link>
      <div className="mt-2 flex items-center gap-3 rounded-control bg-night-raised px-3 py-2.5">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-white"
        >
          {user.name
            .split(" ")
            .map((part) => part[0])
            .slice(0, 2)
            .join("")}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.8125rem] font-semibold text-on-night">{user.name}</p>
          <p className="truncate text-xs text-on-night-muted">{ROLE_LABELS[user.role]}</p>
        </div>
        <button
          type="button"
          onClick={signOut}
          disabled={leaving}
          aria-label="Sign out"
          title="Sign out"
          className="flex size-8 shrink-0 items-center justify-center rounded-control text-on-night-muted hover:bg-night hover:text-on-night"
        >
          <LogOut className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** The four pages staff reach for on a phone. Everything else is one tap away under More. */
const TABS: NavItem[] = [
  { href: "/org", label: "Home", icon: LayoutDashboard, exact: true },
  { href: "/org/events", label: "Events", icon: CalendarDays },
  { href: "/org/check-in", label: "Check-in", icon: ScanLine },
  { href: "/org/finance", label: "Finance", icon: Wallet, needs: "manageFinance" },
];

/** Takes the place of a tab the signed-in role cannot open. */
const FALLBACK_TAB: NavItem = { href: "/org/tasks", label: "Tasks", icon: ListChecks };

const isActive = (item: NavItem, pathname: string) =>
  item.exact ? pathname === item.href : pathname.startsWith(item.href);

/** Sidebar on desktop; top bar, bottom tabs and a full menu on phones. */
export function OrgShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  const user = useSession();
  const tabs = TABS.map((tab) => (tab.needs && !can(user, tab.needs) ? FALLBACK_TAB : tab));
  const onTabPage = tabs.some((tab) => isActive(tab, pathname));

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="min-h-dvh lg:pl-(--sidebar-width)">
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-(--sidebar-width) flex-col bg-night lg:flex">
        <Link href="/org" className="flex h-16 items-center px-5" aria-label="Skyline dashboard">
          <Logo onDark />
        </Link>
        <NavLinks />
        <AccountPanel />
      </aside>

      <header className="no-print sticky top-0 z-30 flex h-14 items-center justify-between bg-night px-4 lg:hidden">
        <Link href="/org" aria-label="Skyline dashboard">
          <Logo onDark />
        </Link>
        <span className="text-xs font-medium text-on-night-muted">{ROLE_LABELS[user.role]}</span>
      </header>

      {menuOpen && (
        <div className="no-print fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            className="absolute inset-0 cursor-default bg-night/60"
          />
          <div className="absolute inset-y-0 right-0 flex w-[min(20rem,88vw)] animate-rise flex-col bg-night shadow-raised">
            <div className="flex h-14 items-center justify-between px-4">
              <Logo onDark />
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
                className="flex size-11 items-center justify-center rounded-control text-on-night hover:bg-night-raised"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <NavLinks onNavigate={() => setMenuOpen(false)} />
            <AccountPanel />
          </div>
        </div>
      )}

      <main id="main" className="pb-tabbar mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6 sm:pt-8 lg:px-8">
        {children}
      </main>

      <nav
        aria-label="Quick navigation"
        className="no-print h-tabbar fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-night-line bg-night lg:hidden"
      >
        {tabs.map((tab) => {
          const active = isActive(tab, pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition-colors",
                active ? "text-white" : "text-on-night-muted hover:text-on-night",
              )}
            >
              {active && <span aria-hidden className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-accent" />}
              <tab.icon className={cn("size-5", active && "text-accent")} aria-hidden />
              {tab.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-expanded={menuOpen}
          aria-label="More pages"
          className={cn(
            "relative flex flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition-colors",
            !onTabPage ? "text-white" : "text-on-night-muted hover:text-on-night",
          )}
        >
          {!onTabPage && <span aria-hidden className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-accent" />}
          <Menu className={cn("size-5", !onTabPage && "text-accent")} aria-hidden />
          More
        </button>
      </nav>
    </div>
  );
}
