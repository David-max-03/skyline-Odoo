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

  it("shows only the common links until the session is known", () => {
    expect(hrefs(undefined)).toEqual(["/", "/events", "/shop"]);
  });
});
