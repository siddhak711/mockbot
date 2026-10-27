import { request, type APIResponse, type Page } from "@playwright/test";

type AuthBody = { user?: { email?: string }; error?: string };

/** The dev server Playwright starts when SMOKE_BASE_URL is unset. */
export const LOCAL_BASE_URL = "http://127.0.0.1:3000";

/** Local runs use a throwaway account in the scratch PGlite directory. */
const LOCAL_SMOKE_EMAIL = "smoke@example.com";
const LOCAL_SMOKE_PASSWORD = "smoke-local-password";

/** The origin of SMOKE_BASE_URL, or undefined when it is unset (local mode). */
export function remoteBaseURL(): string | undefined {
  const raw = process.env.SMOKE_BASE_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SMOKE_BASE_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SMOKE_BASE_URL must be an http or https URL.");
  }
  return url.origin;
}

export function smokeEmail(): string {
  const email = process.env.SMOKE_TEST_EMAIL?.trim().toLowerCase() ?? "";
  if (email) return email;
  if (!remoteBaseURL()) return LOCAL_SMOKE_EMAIL;
  throw new Error(
    "SMOKE_TEST_EMAIL is required with SMOKE_BASE_URL. The smoke test signs in as this account. See the Smoke test section in README.md.",
  );
}

export function smokePassword(): string {
  const password = process.env.SMOKE_TEST_PASSWORD ?? "";
  if (password.trim()) return password;
  if (!remoteBaseURL()) return LOCAL_SMOKE_PASSWORD;
  throw new Error(
    "SMOKE_TEST_PASSWORD is required with SMOKE_BASE_URL. Use at least 10 characters. See the Smoke test section in README.md.",
  );
}

export function protectionHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (!secret) return {};
  return {
    "x-vercel-protection-bypass": secret,
    "x-vercel-set-bypass-cookie": "true",
  };
}

export function accountEmail(page: Page) {
  return page.locator("footer.me .me-meta");
}

export function accountMenuButton(page: Page) {
  return page.locator("footer.me button.user-trigger");
}

function baseURLFrom(baseURL: string | undefined): string {
  if (!baseURL) throw new Error("No base URL is configured for the smoke test.");
  return baseURL;
}

async function readAuth(response: APIResponse, label: string): Promise<AuthBody> {
  const contentType = response.headers()["content-type"] ?? "";
  const text = await response.text();
  if (!contentType.includes("json")) {
    const preview = text.replace(/\s+/g, " ").slice(0, 160);
    throw new Error(
      `${label} did not return JSON (${response.status()} ${contentType || "no content type"}): ${preview}. ` +
        "If this is a Vercel login page, set VERCEL_AUTOMATION_BYPASS_SECRET to the project's Protection Bypass for Automation secret.",
    );
  }
  return JSON.parse(text) as AuthBody;
}

/**
 * Creates the smoke account through the same password route the login form uses.
 * An existing account with this password is left as-is.
 */
export async function ensureSmokeAccount(baseURL: string | undefined): Promise<void> {
  const email = smokeEmail();
  const password = smokePassword();
  const context = await request.newContext({
    baseURL: baseURLFrom(baseURL),
    extraHTTPHeaders: {
      ...protectionHeaders(),
      Accept: "application/json",
    },
    timeout: 60_000,
  });
  try {
    const signIn = await context.post("/api/auth/password", {
      data: { intent: "sign-in", email, password },
    });
    if (signIn.ok()) {
      const body = await readAuth(signIn, "Sign-in");
      if (body.user?.email?.toLowerCase() === email) return;
      throw new Error("Sign-in succeeded but did not return the smoke account email.");
    }
    const signInBody = await readAuth(signIn, "Sign-in");
    if (signIn.status() !== 401) {
      throw new Error(
        `Could not sign in the smoke account (${signIn.status()}): ${signInBody.error ?? "unknown error"}.`,
      );
    }

    const signUp = await context.post("/api/auth/password", {
      data: { intent: "sign-up", email, password, name: "Smoke" },
    });
    const signUpBody = await readAuth(signUp, "Sign-up");
    if (signUp.ok() && signUpBody.user?.email?.toLowerCase() === email) return;
    if (signUp.status() === 409) {
      throw new Error(
        `An account for ${email} already exists, and SMOKE_TEST_PASSWORD did not match it. ` +
          "Use that account's password, or delete the user from the database this deployment uses.",
      );
    }
    throw new Error(
      `Could not create the smoke account (${signUp.status()}): ${signUpBody.error ?? "unknown error"}.`,
    );
  } finally {
    await context.dispose();
  }
}
