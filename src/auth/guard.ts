import { getAppContext } from "../context";
import { readSessionToken, sessionTokenFromCookies } from "./cookies";
import { prepareUser } from "./scope";
import { readSessionUser } from "./sessions";
import type { SignedInUser } from "./user";

export type ApiUser =
  { ok: true; user: SignedInUser; scoped: boolean } | { ok: false; response: Response };

function testBypass(): boolean {
  return (
    process.env.VITEST === "true" &&
    process.env.MOCKBOT_REQUIRE_AUTH !== "1" &&
    process.env.NODE_ENV !== "production" &&
    process.env.VERCEL !== "1"
  );
}

const UNSCOPED_TEST_USER: SignedInUser = {
  id: "user_test",
  name: "Test",
  email: "test@local",
  image: null,
};

export async function requireApiUser(request?: Request): Promise<ApiUser> {
  if (testBypass()) return { ok: true, user: UNSCOPED_TEST_USER, scoped: false };
  const token = request ? readSessionToken(request) : null;
  if (!token) {
    return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const { store } = await getAppContext();
  const user = await readSessionUser(store.connection, token);
  if (!user) {
    return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  await prepareUser(store.connection, user.id);
  return { ok: true, user, scoped: true };
}

/**
 * The password route stores the same database session Auth.js would.
 * `auth()` reports no session when Auth.js itself is misconfigured, which
 * bounced a valid cookie back to /login. Read the cookie here instead.
 */
export async function readSignedInUser(): Promise<SignedInUser | null> {
  const { cookies } = await import("next/headers");
  const token = sessionTokenFromCookies(await cookies());
  if (!token) return null;
  const { store } = await getAppContext();
  return readSessionUser(store.connection, token);
}

export async function requirePageUser(): Promise<SignedInUser> {
  const { redirect } = await import("next/navigation");
  const user = await readSignedInUser();
  if (!user) {
    redirect("/login");
    throw new Error("Unauthenticated");
  }
  const { store } = await getAppContext();
  await prepareUser(store.connection, user.id);
  return user;
}
