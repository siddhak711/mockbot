export const GOOGLE_CALLBACK_PATH = "/api/auth/callback/google";

export function googleOAuthConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}

export function googleCallbackUrl(origin: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}${GOOGLE_CALLBACK_PATH}`;
}
