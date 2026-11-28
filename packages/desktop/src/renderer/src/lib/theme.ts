import type { Theme } from "@dark-matter/contracts";
import { useSyncExternalStore } from "react";

const storageKey = "dark-matter:theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();
let current: Theme = "system";

/** The theme in effect: the chosen one, or the system appearance for System. */
const resolved = (): "light" | "dark" => {
  if (current !== "system") return current;
  return media.matches ? "dark" : "light";
};

const paint = () => {
  document.documentElement.classList.toggle("dark", resolved() === "dark");
  for (const listener of listeners) listener();
};

// Registered once: while the theme is System, a change of the system appearance repaints.
media.addEventListener("change", paint);

/** Switches the theme tokens (`.dark` on <html>) and remembers the choice for the next launch's first paint. */
export const applyTheme = (theme: Theme) => {
  current = theme;
  paint();
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // Storage can be unavailable; the saved preference repaints once settings load.
  }
};

/** Paints the last remembered theme before settings load, so a Light or Dark choice doesn't flash. */
export const applyRememberedTheme = () => {
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(storageKey);
  } catch {
    // Fall through to System.
  }
  applyTheme(remembered === "dark" || remembered === "light" ? remembered : "system");
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The theme in effect, re-rendering when the choice or the system appearance changes. */
export const useResolvedTheme = () => useSyncExternalStore(subscribe, resolved);
