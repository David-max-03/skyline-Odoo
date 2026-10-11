import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Role, SessionUser } from "@/lib/contracts";

vi.mock("next/navigation", () => ({
  usePathname: () => "/org",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

import MembersPage from "@/app/org/members/page";
import { OrgShell } from "@/components/org-shell";
import { ToastProvider } from "@/components/overlay";
import { SessionProvider } from "@/components/session";

/**
 * What a role is actually shown: the committee sidebar and the Members page,
 * rendered to HTML for each role. This is about what appears on screen; that
 * the server refuses the same things is tested in authorization.test.ts.
 */

const as = (role: Role): SessionUser => ({ id: `usr_${role}`, name: "Test Person", email: `${role}@test.example`, role, memberId: null, memberNo: null });

/** The session provider, typed so its content can be passed as a child rather than a prop. */
const Session = SessionProvider as ComponentType<{ user: SessionUser }>;

const render = (role: Role, page: ComponentType) =>
  renderToStaticMarkup(createElement(Session, { user: as(role) }, createElement(ToastProvider, null, createElement(page))));

const sidebar = (role: Role) => renderToStaticMarkup(createElement(Session, { user: as(role) }, createElement(OrgShell, null, "page")));

/** The hrefs of every link in the rendered markup. */
const hrefs = (html: string) => new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]));

describe("the committee sidebar", () => {
  it("shows the treasurer no Check-in and no Volunteer tasks, and everything a treasurer uses", () => {
    const html = sidebar("treasurer");
    const links = hrefs(html);
    expect(links.has("/org/check-in")).toBe(false);
    expect(links.has("/org/tasks")).toBe(false);
    expect(html).not.toContain("Check-in");
    expect(html).not.toContain("Volunteer tasks");
    for (const href of ["/org", "/org/events", "/org/finance", "/org/claims", "/org/members", "/org/merch", "/org/announcements"]) {
      expect(links.has(href)).toBe(true);
    }
    expect(links.has("/org/accounts")).toBe(false);
  });

  it("shows the president everything", () => {
    const links = hrefs(sidebar("admin"));
    for (const href of ["/org", "/org/events", "/org/check-in", "/org/tasks", "/org/finance", "/org/claims", "/org/members", "/org/merch", "/org/announcements", "/org/accounts"]) {
      expect(links.has(href)).toBe(true);
    }
  });

  it("shows the event handler the door and the tasks, and no money, members, merchandise or accounts", () => {
    const links = hrefs(sidebar("organizer"));
    for (const href of ["/org", "/org/events", "/org/check-in", "/org/tasks", "/org/claims", "/org/announcements"]) {
      expect(links.has(href)).toBe(true);
    }
    for (const href of ["/org/finance", "/org/members", "/org/merch", "/org/accounts"]) {
      expect(links.has(href)).toBe(false);
    }
  });
});

describe("the Members page", () => {
  it("has no Add member button at all for the treasurer", () => {
    const html = render("treasurer", MembersPage);
    expect(html).toContain("Members");
    expect(html).not.toContain("Add member");
    expect(html).not.toContain("Add a member");
  });

  it("has the Add member button for the president", () => {
    expect(render("admin", MembersPage)).toContain("Add member");
  });
});
