import { defineConfig, devices } from "@playwright/test";
import { LOCAL_BASE_URL, protectionHeaders, remoteBaseURL } from "./e2e/auth";

/**
 * Two modes:
 * - SMOKE_BASE_URL unset: start `npm run dev` on 127.0.0.1:3000 against a scratch
 *   PGlite directory, with the labeled mock model opted in.
 * - SMOKE_BASE_URL set: run against that app (a local server or a Vercel
 *   deployment). Nothing is started, and the smoke account comes from
 *   SMOKE_TEST_EMAIL and SMOKE_TEST_PASSWORD.
 */
const remote = remoteBaseURL();
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  workers: 1,
  reporter: ci ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: remote ?? LOCAL_BASE_URL,
    extraHTTPHeaders: protectionHeaders(),
    navigationTimeout: 45_000,
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: process.env.SMOKE_VIDEO === "1" ? "on" : "off",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: remote
    ? undefined
    : {
        command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
        url: LOCAL_BASE_URL,
        reuseExistingServer: true,
        timeout: 120_000,
        env: {
          AUTH_SECRET: "playwright-auth-secret-not-for-production",
          AUTH_URL: LOCAL_BASE_URL,
          DATA_DIR: "/tmp/mockbot-playwright",
          // Explicit opt-in to the labeled mock model (section 4 of AGENTS.md).
          LLM_PROVIDER: "mock",
        },
      },
});
