"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  resolveTheme,
  systemScheme,
  toggleTheme,
  type ColorScheme,
  type ThemePreference,
} from "../src/theme";

type ThemeValue = {
  preference: ThemePreference;
  scheme: ColorScheme;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [system, setSystem] = useState<ColorScheme>("light");
  const [ready, setReady] = useState(false);
  const scheme = resolveTheme(preference, system);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setSystem(systemScheme(media.matches));
    apply();
    setReady(true);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!ready && preference === "system") return;
    document.documentElement.dataset.theme = scheme;
    document.documentElement.style.colorScheme = scheme;
  }, [scheme, ready, preference]);

  const toggle = useCallback(() => {
    setPreference(toggleTheme(scheme));
  }, [scheme]);

  const value = useMemo(() => ({ preference, scheme, toggle }), [preference, scheme, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is missing");
  return value;
}

export function ThemeToggle() {
  const { scheme, toggle } = useTheme();
  const next = scheme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      aria-label={`Switch to ${next} theme`}
      onClick={toggle}
    >
      {scheme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5Z" strokeLinejoin="round" />
    </svg>
  );
}
