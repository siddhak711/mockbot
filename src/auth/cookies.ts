import type { SignedInUser } from "./user";

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const SESSION_COOKIE = "authjs.session-token";

export const SECURE_SESSION_COOKIE = `__Secure-${SESSION_COOKIE}`;

const SESSION_COOKIE_NAMES = [SESSION_COOKIE, SECURE_SESSION_COOKIE];

type Env = Record<string, string | undefined>;

/**
 * Auth.js chooses the secure cookie prefix from AUTH_URL when that variable
 * is set, and from the request protocol otherwise. Password sign-in has to
 * write the same cookie the database session lookup reads.
 */
export function secureSessionCookies(request?: Request, env: Env = process.env): boolean {
  const configured = env.AUTH_URL?.trim() || env.NEXTAUTH_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).protocol === "https:";
    } catch {
      return false;
    }
  }
  if (!request) return false;
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim() === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const value = trimmed.slice(eq + 1);
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  for (const name of SESSION_COOKIE_NAMES) {
    const value = readCookie(header, name);
    if (value) return value;
  }
  return null;
}

export function sessionCookieHeader(token: string, expires: Date, request: Request): string {
  const secure = secureSessionCookies(request);
  const parts = [
    `${sessionCookieName(secure)}=${token}`,
    "Path=/",
    `Expires=${expires.toUTCString()}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function sessionExpiry(now = Date.now()): Date {
  return new Date(now + SESSION_MAX_AGE_SECONDS * 1000);
}

export function publicUser(user: SignedInUser): SignedInUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
  };
}
