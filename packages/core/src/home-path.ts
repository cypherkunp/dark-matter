import { sep } from "node:path";

/** Shows a path under `$HOME` as `~/…`, the portable form owned state uses (ADR-0005). */
export const homeRelative = (home: string, path: string): string =>
  path === home ? "~" : path.startsWith(home + sep) ? `~/${path.slice(home.length + 1)}` : path;

/** The inverse of `homeRelative`: expands a leading `~/`. */
export const homeAbsolute = (home: string, path: string): string =>
  path === "~" ? home : path.startsWith("~/") ? `${home}${sep}${path.slice(2)}` : path;
