import type { HighlighterTypes, ThemesType } from "@pierre/diffs";
import { useResolvedTheme } from "@/lib/theme";

/**
 * Read-only code is rendered by Pierre's `@pierre/diffs`, the same viewer T3 Code uses.
 * Its Highlights backend tokenizes with hand-written WASM lexers, many times faster than
 * Shiki's JS regex engine and without backtracking. The WASM is inlined in the bundle, so
 * the CSP only needs `'wasm-unsafe-eval'`.
 */
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = "highlights";

/** Both palettes, so the viewer follows the app's theme without a new highlighter. */
export const CODE_THEMES: ThemesType = { light: "pierre-light", dark: "pierre-dark" };

/** The theme in effect (Settings › Appearance), as `applyTheme` paints the app's tokens. */
export const useColorScheme = useResolvedTheme;
