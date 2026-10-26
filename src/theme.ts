export type ThemePreference = "system" | "light" | "dark";

export type ColorScheme = "light" | "dark";

/** The theme on screen. "system" follows the operating system setting. */
export function resolveTheme(preference: ThemePreference, systemScheme: ColorScheme): ColorScheme {
  if (preference === "system") return systemScheme;
  return preference;
}

export function systemScheme(prefersDark: boolean): ColorScheme {
  return prefersDark ? "dark" : "light";
}

/**
 * Leaves system-follow and pins the opposite of the scheme currently on screen.
 * A reload starts from "system" again; the spec does not say to store an override.
 */
export function toggleTheme(resolved: ColorScheme): Exclude<ThemePreference, "system"> {
  return resolved === "dark" ? "light" : "dark";
}
