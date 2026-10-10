"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SETTINGS } from "@/lib/contracts";
import { cn } from "./ui";

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

const LINKS = [
  { href: "/events", label: "Events" },
  { href: "/shop", label: "Shop" },
  { href: "/news", label: "News" },
  { href: "/join", label: "Join" },
];

/** Header and footer for the pages students and visitors see. */
export function PublicShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="no-print sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" aria-label="Skyline home" className="rounded-control">
            <Logo compact />
          </Link>
          <nav aria-label="Main" className="flex items-center gap-0.5 sm:gap-1">
            {LINKS.map((link) => {
              const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-control px-2.5 py-2 text-sm font-medium transition-colors sm:px-3",
                    active ? "bg-brand-soft text-brand-deep" : "text-muted hover:bg-sunken hover:text-ink",
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {children}
      </main>
      <footer className="no-print border-t border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-[0.8125rem] text-muted sm:px-6">
          <p>{SETTINGS.orgName}</p>
          <Link href="/login" className="font-medium text-brand hover:underline">
            Committee sign-in
          </Link>
        </div>
      </footer>
    </div>
  );
}
