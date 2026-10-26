"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAppContext } from "../context";
import { clearedSessionCookie, SECURE_SESSION_COOKIE, SESSION_COOKIE } from "./cookies";
import { googleOAuthConfigured } from "./google";
import { signIn } from "./index";
import { safeNext } from "./next-path";
import { deleteDatabaseSession } from "./sessions";

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const next = safeNext(String(formData.get("next") ?? "/"));
  if (!googleOAuthConfigured()) {
    redirect(`/login?error=GoogleSignInNotConfigured&next=${encodeURIComponent(next)}`);
  }
  await signIn("google", { redirectTo: next });
}

export async function signOutAction(): Promise<void> {
  const jar = await cookies();
  const tokens = [SESSION_COOKIE, SECURE_SESSION_COOKIE]
    .map((name) => jar.get(name)?.value)
    .filter((value): value is string => Boolean(value));
  if (tokens.length > 0) {
    const { store } = await getAppContext();
    for (const token of tokens) await deleteDatabaseSession(store.connection, token);
  }
  for (const name of [SESSION_COOKIE, SECURE_SESSION_COOKIE]) {
    const cleared = clearedSessionCookie(name);
    jar.set(cleared.name, cleared.value, cleared.options);
  }
  redirect("/login");
}
