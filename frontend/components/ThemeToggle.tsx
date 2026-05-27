"use client";

import { useSyncExternalStore } from "react";
import { EVENTS, track } from "@/lib/analytics";

type Theme = "light" | "dark";

const STORAGE_KEY = "bigset:theme";
const THEME_CHANGED_EVENT = "bigset:theme-changed";

/**
 * The same selection logic that runs in the inline `<head>` script
 * (see app/layout.tsx). Kept here so the toggle stays in sync after
 * hydration and so it can read the effective theme post-mount.
 */
function readEffectiveTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage may be blocked (Safari private mode etc.)
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

function subscribeToThemeChange(onThemeChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onThemeChange);
  window.addEventListener(THEME_CHANGED_EVENT, onThemeChange);
  return () => {
    window.removeEventListener("storage", onThemeChange);
    window.removeEventListener(THEME_CHANGED_EVENT, onThemeChange);
  };
}

function readServerTheme(): Theme {
  return "light";
}

export function useTheme() {
  const theme = useSyncExternalStore(
    subscribeToThemeChange,
    readEffectiveTheme,
    readServerTheme,
  );

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
    track(EVENTS.THEME_CHANGED, { theme: next });
  }

  return { theme, toggle } as const;
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center h-7 w-7 text-muted hover:text-foreground transition-colors ${className}`}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
