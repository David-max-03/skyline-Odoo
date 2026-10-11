import { describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/contracts";
import { publicNavLinks } from "@/lib/public-nav";

const member: SessionUser = {
  id: "mem_1",
  name: "Mira Member",
  email: "mira@campus.example",
  role: "member",
  memberId: "mem_1",
  memberNo: "SKY-M-0027",
};
const treasurer: SessionUser = { id: "usr_1", name: "Tariq", email: "t@campus.example", role: "treasurer", memberId: null, memberNo: null };

const hrefs = (user: SessionUser | null | undefined) => publicNavLinks(user).map((link) => link.href);

/**
 * The public header used to list "Become a member" and "Login" for everyone,
 * so a signed-in member who opened Merchandise looked signed out.
 */
describe("public header links", () => {
  it("offers a visitor the way in", () => {
    expect(hrefs(null)).toEqual(["/", "/events", "/shop", "/join", "/login"]);
  });

  it("never tells a signed-in member to log in or join", () => {
    expect(hrefs(member)).toEqual(["/", "/events", "/shop", "/member"]);
    expect(publicNavLinks(member).at(-1)?.label).toBe("My account");
  });

  it("sends a committee account back to the committee area", () => {
    expect(hrefs(treasurer)).toEqual(["/", "/events", "/shop", "/org"]);
  });

  it("calls the way back \"My account\" for a member and for the treasurer, and \"Committee\" for the president and event handler", () => {
    const label = (user: SessionUser | null) => publicNavLinks(user).at(-1)?.label;
    expect(label(null)).toBe("Login");
    expect(label(member)).toBe("My account");
    expect(label(treasurer)).toBe("My account");
    expect(label({ ...treasurer, role: "admin" })).toBe("Committee");
    expect(label({ ...treasurer, role: "organizer" })).toBe("Committee");
    // The wording changes, never where it leads or who may open it.
    expect(publicNavLinks(treasurer).at(-1)?.href).toBe("/org");
    // One way in or back, never two, and nothing from the committee menu.
    for (const user of [null, member, treasurer]) {
      const links = publicNavLinks(user);
      expect(links.filter((l) => ["/login", "/member", "/org"].includes(l.href))).toHaveLength(1);
      expect(links.some((l) => l.href.startsWith("/org/"))).toBe(false);
    }
  });

  it("shows only the common links until the session is known", () => {
    expect(hrefs(undefined)).toEqual(["/", "/events", "/shop"]);
  });
});
