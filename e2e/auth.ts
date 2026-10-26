import { request, type APIResponse, type Page } from "@playwright/test";

type AuthBody = { user?: { email?: string }; error?: string };

export function smokeEmail(): string {
  const email = process.env.SMOKE_TEST_EMAIL?.trim().toLowerCase() ?? "";
  if (!email) {
    throw new Error(
      "SMOKE_TEST_EMAIL is required. The smoke test signs in as this account. See the Smoke test section in README.md.",
    );
  }
  return email;
}

export function smokePassword(): string {
  const password = process.env.SMOKE_TEST_PASSWORD ?? "";
  if (!password.trim()) {
    throw new Error(
      "SMOKE_TEST_PASSWORD is required. Use at least 10 characters. See the Smoke test section in README.md.",
    );
  }
  return password;
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
  if (!baseURL) throw new Error("SMOKE_BASE_URL is required.");
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
