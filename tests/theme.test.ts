import { expect, it } from "vitest";
import { initialSystemScheme, resolveTheme, systemScheme, toggleTheme } from "../src/theme";

it("follows the system setting until the toggle pins a scheme", () => {
  expect(systemScheme(true)).toBe("dark");
  expect(systemScheme(false)).toBe("light");

  expect(resolveTheme("system", "dark")).toBe("dark");
  expect(resolveTheme("system", "light")).toBe("light");

  expect(resolveTheme("light", "dark")).toBe("light");
  expect(resolveTheme("dark", "light")).toBe("dark");
});

it("reads the boot script theme before a system-mode first paint", () => {
  expect(initialSystemScheme({ dataTheme: "dark", prefersDark: false })).toBe("dark");
  expect(initialSystemScheme({ dataTheme: "light", prefersDark: true })).toBe("light");
  expect(initialSystemScheme({ prefersDark: true })).toBe("dark");
  expect(initialSystemScheme({ prefersDark: false })).toBe("light");
  expect(initialSystemScheme({})).toBe("light");
  expect(initialSystemScheme({ dataTheme: "system", prefersDark: true })).toBe("dark");
});

it("toggles to the opposite of the scheme on screen", () => {
  expect(toggleTheme("dark")).toBe("light");
  expect(toggleTheme("light")).toBe("dark");
  expect(resolveTheme(toggleTheme("dark"), "dark")).toBe("light");
  expect(resolveTheme(toggleTheme("light"), "light")).toBe("dark");
});
