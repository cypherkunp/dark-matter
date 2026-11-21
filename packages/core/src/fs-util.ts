import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";

/** Small shared fs and JSON helpers (review #23). */

/** Whether anything is at `path`, a dangling symlink included (lstat). */
export const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Whether `path` resolves to something, following symlinks (stat). */
export const resolves = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Whether `path` is a folder, following symlinks. */
export const isDirectory = (path: string) =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

/** Whether `path` itself is a real folder, not a symlink to one. */
export const isRealDirectory = (path: string) =>
  lstat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

export const lstatOrNull = (path: string) => lstat(path).catch(() => null);

/** `path` is `root` or inside it. */
export const within = (path: string, root: string) => path === root || path.startsWith(root + sep);

/** Visible subfolders of `path`, sorted; none when it's missing. */
export const subdirs = async (path: string): Promise<string[]> => {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(path, entry.name))
      .sort();
  } catch {
    return [];
  }
};

/** A JSON file's value, or undefined when it's missing or doesn't parse. */
export const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

export type JsonObject = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` if it's a plain object, else `{}`. */
export const asObject = (value: unknown): JsonObject => (isRecord(value) ? value : {});

/** A TOML key, quoted unless it's bare-safe. */
export const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));
