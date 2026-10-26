import { defineConfig, devices } from "@playwright/test";
import { protectionHeaders } from "./e2e/auth";

function smokeBaseURL(): string {
  const raw = process.env.SMOKE_BASE_URL?.trim();
  if (!raw) {
    throw new Error(
      "SMOKE_BASE_URL is required. Point it at a running app, for example http://127.0.0.1:3000 or a Vercel deployment URL.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SMOKE_BASE_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SMOKE_BASE_URL must be an http or https URL.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

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
    baseURL: smokeBaseURL(),
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
});
