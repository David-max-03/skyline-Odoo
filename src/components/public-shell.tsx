"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useApi } from "@/lib/api-client";
import { cart } from "@/lib/cart";
import { SETTINGS, type SessionUser } from "@/lib/contracts";
import { publicNavLinks } from "@/lib/public-nav";
import { LayoutDashboard, LogIn, UserRound } from "lucide-react";
import { CartLink } from "./shop-ui";
import { buttonClass, cn } from "./ui";

/** The Skyline mark: a row of rooftops with the sun coming up behind them. */
export function Logo({
  onDark = false,
  compact = false,
  className,
}: {
  onDark?: boolean;
  /** Drop the wordmark on very narrow screens, where the nav needs the room. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="8" className={onDark ? "fill-brand" : "fill-night"} />
        <circle cx="22.5" cy="11" r="3.5" className="fill-accent" />
        <path d="M6 25V16h4.5v9zM12 25V10h5v15zM18.5 25v-7H23v7zM24.5 25v-4h2.5v4z" fill="#fff" />
      </svg>
      <span
        className={cn(
          "font-display text-lg font-extrabold tracking-tight",
          onDark ? "text-on-night" : "text-ink",
          compact && "max-[379px]:sr-only",
        )}
      >
        Skyline
      </span>
    </span>
  );
}

/**
 * Who is looking at a public page: a signed-in account, `null` for a visitor,
 * or `undefined` while that is still being worked out. For display only.
 */
const VisitorContext = createContext<SessionUser | null | undefined>(undefined);
export const useVisitor = () => useContext(VisitorContext);

/** Login for a visitor, or the signed-in person's own area. Shown as a button, not in the link row. */
const ENTRY_HREFS = ["/login", "/member", "/org"];

/** Header and footer for the pages students and visitors see. */
export function PublicShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // The same session check the member and committee layouts use. A failed check shows the visitor menu.
  const me = useApi<{ user: SessionUser | null }>("/api/auth/me");
  const visitor = me.data ? me.data.user : me.error ? null : undefined;
  // Once the session is known, make sure the cart on this browser is this person's.
  const visitorId = visitor === undefined ? undefined : (visitor?.id ?? null);
  useEffect(() => {
    if (visitorId !== undefined) cart.syncOwner(visitorId);
  }, [visitorId]);
  const links = publicNavLinks(visitor);
  const account = links.find((link) => link.href === "/member" || link.href === "/org");
  // The way in (or back to one's own area) sits beside the cart, outside the row of
  // links that scrolls on a narrow screen, so it can never be scrolled out of view.
  const entry = links.find((link) => ENTRY_HREFS.includes(link.href));
  const EntryIcon = entry?.href === "/login" ? LogIn : entry?.label === "Committee" ? LayoutDashboard : UserRound;
  return (
    <VisitorContext.Provider value={visitor}>
      <div className="flex min-h-dvh flex-col">
        <header className="no-print sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
          <div className="page-shell flex h-16 items-center justify-between gap-4">
            <Link href="/" aria-label="Skyline home" className="rounded-control">
              <Logo compact />
            </Link>
            <nav aria-label="Main" className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto sm:gap-1">
              {links.filter((link) => link !== entry).map((link) => {
                const active = link.href === "/" ? pathname === "/" : pathname === link.href || pathname.startsWith(`${link.href}/`);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "shrink-0 whitespace-nowrap rounded-control px-2.5 py-2 text-sm font-medium transition-colors sm:px-3",
                      active ? "bg-brand-soft text-brand-deep" : "text-muted hover:bg-sunken hover:text-ink",
                    )}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>
            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              {entry && (
                <Link href={entry.href} className={buttonClass(entry.href === "/login" ? "primary" : "secondary", "sm")}>
                  <EntryIcon className="size-4 shrink-0 max-[379px]:hidden" aria-hidden />
                  {entry.label}
                </Link>
              )}
              <CartLink />
            </div>
          </div>
        </header>
        <main id="main" className="page-shell flex-1 py-(--page-space)">
          {children}
        </main>
        <footer className="no-print border-t border-line bg-surface">
          <div className="page-shell flex flex-wrap items-center justify-between gap-3 py-5 text-[0.8125rem] text-muted">
            <p>{SETTINGS.orgName}</p>
            <p className="flex gap-4">
              <Link href="/news" className="font-medium text-brand hover:underline">
                News
              </Link>
              {/* A visitor already has Login in the header; only a signed-in person gets a second way back. */}
              {account && (
                <Link href={account.href} className="font-medium text-brand hover:underline">
                  {account.label}
                </Link>
              )}
            </p>
          </div>
        </footer>
      </div>
    </VisitorContext.Provider>
  );
}
