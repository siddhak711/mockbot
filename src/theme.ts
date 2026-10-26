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

/** Apply the system scheme before paint. An explicit toggle replaces it after load. */
export const themeBootScript = `(function(){try{var dark=window.matchMedia("(prefers-color-scheme: dark)").matches;var theme=dark?"dark":"light";var root=document.documentElement;root.setAttribute("data-theme",theme);root.style.colorScheme=theme;}catch(e){}})();`;
