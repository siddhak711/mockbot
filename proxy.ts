import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SECURE_SESSION_COOKIE, SESSION_COOKIE } from "./src/auth/cookies";

const PUBLIC_PATHS = new Set(["/login"]);

function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.has(SESSION_COOKIE) || request.cookies.has(SECURE_SESSION_COOKIE);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }
  if (hasSessionCookie(request)) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  const next = `${pathname}${request.nextUrl.search}`;
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/|sprites/|.*\\..*).*)"],
};
