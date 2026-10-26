import { expect, test } from "@playwright/test";
import { accountEmail, accountMenuButton, smokeEmail, smokePassword } from "./auth";

/**
 * Login and logout only.
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
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
  await expect(accountEmail(page)).toHaveText(email);

  await accountMenuButton(page).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(isLogin);

  await page.goto("/");
  await expect(page).toHaveURL(isLogin);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(accountEmail(page)).toHaveCount(0);
});
