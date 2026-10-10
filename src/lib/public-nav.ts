import type { SessionUser } from "./contracts";

export interface PublicNavLink {
  href: string;
  label: string;
}

const BROWSE: PublicNavLink[] = [
  { href: "/", label: "Home" },
  { href: "/events", label: "Events" },
  { href: "/shop", label: "Merchandise" },
];

/**
 * The public header's links for whoever is looking at it. The public pages
 * are open to everyone, but a signed-in member or committee account must not
 * be shown "Login" as if they had been signed out.
 *
 * `undefined` means the session is not known yet: only the links that are the
 * same for everyone are shown, so the menu never flashes the wrong state.
 * This decides what is displayed, nothing more; the server authorises every request.
 */
export function publicNavLinks(user: SessionUser | null | undefined): PublicNavLink[] {
  if (user === undefined) return BROWSE;
  if (user === null) {
    return [...BROWSE, { href: "/join", label: "Become a member" }, { href: "/login", label: "Login" }];
  }
  return [...BROWSE, user.role === "member" ? { href: "/member", label: "My account" } : { href: "/org", label: "Committee" }];
}
