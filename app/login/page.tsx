import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginScreen } from "../../components/login-screen";
import { readSignedInUser } from "../../src/auth/guard";
import { safeNext } from "../../src/auth/next-path";

export const metadata: Metadata = {
  title: "Sign in · Mockbot",
  description: "Sign in to your Mockbot workspace",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; next?: string | string[] }>;
}) {
  const params = await searchParams;
  const nextValue = Array.isArray(params.next) ? params.next[0] : params.next;
  const nextPath = safeNext(nextValue);
  if (await readSignedInUser()) redirect(nextPath);
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  return <LoginScreen initialError={error} nextPath={nextPath} />;
}
