import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:3000",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      AUTH_SECRET: "playwright-auth-secret-not-for-production",
      AUTH_URL: "http://127.0.0.1:3000",
      DATA_DIR: "/tmp/mockbot-playwright",
    },
  },
});
