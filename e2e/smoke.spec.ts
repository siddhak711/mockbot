import { expect, test } from "@playwright/test";
import { accountEmail, accountMenuButton, remoteBaseURL, smokeEmail, smokePassword } from "./auth";

/**
 * Login and logout, plus the one-thread-per-agent sidebar.
 * Connector and run-view specs can be added beside this file. They share
 * e2e/global-setup.ts, which creates the smoke account, and the sidebar
 * locators in e2e/auth.ts.
 */

function isLogin(url: URL): boolean {
  return url.pathname === "/login";
}

function isHome(url: URL): boolean {
  return url.pathname === "/";
}

test("anonymous visitor signs in, sees their email, and logs out", async ({ page }) => {
  const email = smokeEmail();

  await page.goto("/");
  await expect(page).toHaveURL(isLogin);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(smokePassword());
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(isHome, { timeout: 45_000 });
  // The sidebar lists agents, never conversations, and has no New chat action.
  await expect(page.getByRole("button", { name: /Mockbot/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "New chat" })).toHaveCount(0);
  await expect(accountEmail(page)).toHaveText(email);

  await accountMenuButton(page).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(isLogin);

  await page.goto("/");
  await expect(page).toHaveURL(isLogin);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(accountEmail(page)).toHaveCount(0);
});

test("sidebar is agents and an agent opens its thread", async ({ page }) => {
  // Creates a fresh account and relies on the labeled mock model, so it only
  // runs against the local dev server that playwright.config.ts starts.
  test.skip(Boolean(remoteBaseURL()), "Local dev server only.");

  await page.goto("/login");
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Email").fill(`smoke-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill("smoke-password");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("button", { name: "New chat" })).toHaveCount(0);
  await expect(page.getByText("Conversations")).toHaveCount(0);
  await expect(page.getByText("Today")).toHaveCount(0);
  await expect(page.getByText("Start a conversation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Mockbot/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Hello from Mockbot/ })).toBeVisible();

  const message = `grove ${Date.now()}`;
  await page.getByRole("textbox", { name: "Message" }).fill(message);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("mock reply")).toBeVisible();
  const sent = page.getByLabel("You").getByText(message);
  await expect(sent).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: /Hello from Mockbot/ })).toHaveCount(0);
  await expect(sent).toBeVisible();
  await expect(page.getByRole("button", { name: "New chat" })).toHaveCount(0);
});
