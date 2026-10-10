import { NextResponse, type NextRequest } from "next/server";

/**
 * Sends visitors without a session cookie from /org/* to the sign-in page.
 *
 * This is a convenience redirect only. It does not validate the cookie and is
 * not the security boundary: every API route checks the session and role on
 * the server (src/server/http.ts).
 */
export function proxy(request: NextRequest) {
  if (request.cookies.has("skyline_session")) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = { matcher: ["/org/:path*"] };
