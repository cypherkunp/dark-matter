import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic";

/**
 * The `skills` CLI's global lock (version 3): `~/.agents/.skill-lock.json`, or
 * `~/.local/state/skills/.skill-lock.json` (its `$XDG_STATE_HOME` default).
 * Dark Matter reads it for Sources and removes entries it Adopts, so
 * `npx skills update -g` doesn't bring them back.
 */
export const globalLockPaths = (home: string) => [
  join(home, ".agents/.skill-lock.json"),
  join(home, ".local/state/skills/.skill-lock.json"),
];

const GlobalLock = z.looseObject({ skills: z.record(z.string(), z.unknown()) });

/** One entry, read leniently: only `source` is required. */
export const GlobalLockEntry = z.looseObject({
  source: z.string().min(1),
  sourceType: z.string().optional().catch(undefined),
  ref: z.string().optional().catch(undefined),
  commit: z.string().optional().catch(undefined),
  skillPath: z.string().optional().catch(undefined),
});
export type GlobalLockEntry = z.infer<typeof GlobalLockEntry>;

export interface GlobalLockFile {
  path: string;
  /** Every entry as written, by installed name. */
  raw: Record<string, Record<string, unknown>>;
  /** The entries that parse. */
  entries: Record<string, GlobalLockEntry>;
}

/** The first global lock that exists and parses, or null. */
export const readGlobalLock = async (home: string): Promise<GlobalLockFile | null> => {
  for (const path of globalLockPaths(home)) {
    try {
      const lock = GlobalLock.safeParse(JSON.parse(await readFile(path, "utf8")));
      if (!lock.success) continue;
      const raw: GlobalLockFile["raw"] = {};
      const entries: GlobalLockFile["entries"] = {};
      for (const [name, value] of Object.entries(lock.data.skills)) {
        if (value && typeof value === "object") raw[name] = value as Record<string, unknown>;
        const entry = GlobalLockEntry.safeParse(value);
        if (entry.success) entries[name] = entry.data;
      }
      return { path, raw, entries };
    } catch {
      // Missing or unreadable: try the next location.
    }
  }
  return null;
};

/**
 * Rewrites the global lock with `edit` applied to its `skills`: a backup copy
 * first, then an atomic write in the CLI's own format (2-space JSON).
 * Resolves to the paths written.
 */
export const editGlobalLock = async (
  path: string,
  backup: string,
  edit: (skills: Record<string, unknown>) => void,
): Promise<string[]> => {
  const text = await readFile(path, "utf8").catch(() => null);
  const lock = text === null ? { version: 3, skills: {} } : GlobalLock.parse(JSON.parse(text));
  edit(lock.skills);
  const written: string[] = [];
  if (text !== null) {
    await mkdir(join(backup, ".."), { recursive: true });
    await copyFile(path, backup);
    written.push(backup);
  } else {
    await mkdir(join(path, ".."), { recursive: true });
  }
  await writeFileAtomic(path, JSON.stringify(lock, null, 2));
  written.push(path);
  return written;
};

/**
 * A Project's `skills-lock.json` entries by installed name, read leniently for
 * their Source (the Namespace an untracked Skill is Adopted into, #29). Empty
 * when it's missing or doesn't parse.
 */
export const projectLockSources = async (project: string): Promise<Record<string, GlobalLockEntry>> => {
  try {
    const lock = GlobalLock.safeParse(JSON.parse(await readFile(join(project, "skills-lock.json"), "utf8")));
    if (!lock.success) return {};
    const entries: Record<string, GlobalLockEntry> = {};
    for (const [name, value] of Object.entries(lock.data.skills)) {
      const entry = GlobalLockEntry.safeParse(value);
      if (entry.success) entries[name] = entry.data;
    }
    return entries;
  } catch {
    return {};
  }
};
