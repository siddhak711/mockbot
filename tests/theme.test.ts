import { expect, it } from "vitest";
import { resolveTheme, systemScheme, toggleTheme } from "../src/theme";

it("follows the system setting until the toggle pins a scheme", () => {
  expect(systemScheme(true)).toBe("dark");
  expect(systemScheme(false)).toBe("light");

  expect(resolveTheme("system", "dark")).toBe("dark");
  expect(resolveTheme("system", "light")).toBe("light");

  expect(resolveTheme("light", "dark")).toBe("light");
  expect(resolveTheme("dark", "light")).toBe("dark");
});

it("toggles to the opposite of the scheme on screen", () => {
  expect(toggleTheme("dark")).toBe("light");
  expect(toggleTheme("light")).toBe("dark");
  expect(resolveTheme(toggleTheme("dark"), "dark")).toBe("light");
  expect(resolveTheme(toggleTheme("light"), "light")).toBe("dark");
});
