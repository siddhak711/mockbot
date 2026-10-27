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
 * Scheme to paint before a system-mode provider has subscribed to the OS.
 * The boot script's data-theme wins, then the live media query.
 */
export function initialSystemScheme(input: {
  dataTheme?: string | null;
  prefersDark?: boolean | null;
}): ColorScheme {
  if (input.dataTheme === "dark" || input.dataTheme === "light") return input.dataTheme;
  if (input.prefersDark != null) return systemScheme(input.prefersDark);
  return "light";
}

/** Where the chosen theme is kept. Settings and the header toggle both write it. */
export const THEME_STORAGE_KEY = "mockbot.theme";

export function parsePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** Leaves system-follow and pins the opposite of the scheme currently on screen. */
export function toggleTheme(resolved: ColorScheme): Exclude<ThemePreference, "system"> {
  return resolved === "dark" ? "light" : "dark";
}

/** Paint the stored choice, or the system scheme, before the first frame. */
export const themeBootScript = `(function(){try{var root=document.documentElement;var stored=null;try{stored=window.localStorage.getItem("${THEME_STORAGE_KEY}");}catch(e){}var theme=stored==="light"||stored==="dark"?stored:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");root.setAttribute("data-theme",theme);root.style.colorScheme=theme;}catch(e){}})();`;
