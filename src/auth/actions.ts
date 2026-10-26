"use server";

import { redirect } from "next/navigation";
import { googleOAuthConfigured } from "./google";
import { signIn, signOut } from "./index";
import { safeNext } from "./next-path";

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const next = safeNext(String(formData.get("next") ?? "/"));
  if (!googleOAuthConfigured()) {
    redirect(`/login?error=GoogleSignInNotConfigured&next=${encodeURIComponent(next)}`);
  }
  await signIn("google", { redirectTo: next });
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
