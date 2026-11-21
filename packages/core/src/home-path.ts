import { sep } from "node:path";

/** Shows a path under `$HOME` as `~/…`, the portable form owned state uses (ADR-0005). */
export const homeRelative = (home: string, path: string): string =>
  path === home ? "~" : path.startsWith(home + sep) ? `~/${path.slice(home.length + 1)}` : path;
