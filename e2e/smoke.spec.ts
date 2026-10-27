import { expect, test } from "@playwright/test";

test("sidebar is agents and an agent opens its thread", async ({ page }) => {
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
