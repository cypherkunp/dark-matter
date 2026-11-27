import type { HighlighterTypes, ThemesType } from "@pierre/diffs";
import { useEffect, useState } from "react";

/**
 * Read-only code is rendered by Pierre's `@pierre/diffs`, the same viewer T3 Code uses.
 * Its Highlights backend tokenizes with hand-written WASM lexers, many times faster than
 * Shiki's JS regex engine and without backtracking. The WASM is inlined in the bundle, so
 * the CSP only needs `'wasm-unsafe-eval'`.
 */
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = "highlights";

/** Both palettes, so the viewer follows the system appearance without a new highlighter. */
export const CODE_THEMES: ThemesType = { light: "pierre-light", dark: "pierre-dark" };

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

/** The system appearance, as `followSystemTheme` applies it to the app's tokens. */
export function useColorScheme(): "light" | "dark" {
  const [scheme, setScheme] = useState<"light" | "dark">(() => (darkQuery().matches ? "dark" : "light"));
  useEffect(() => {
    const media = darkQuery();
    const apply = () => setScheme(media.matches ? "dark" : "light");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  return scheme;
}
