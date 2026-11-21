import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { type LockedSkill, NotInLibrary, type ProjectRecord, type RepoSkills } from "@dark-matter/contracts";
import { agentAdapters } from "./agents";
import { deliveredName } from "./delivery";
import { type Library, splitKey } from "./library";
import { COPY_FOLDER, lockEntry, type ProjectLockEntry, readProjectLock } from "./project-lock";
import { scanProject } from "./scanner";

/**
 * What's committed in a Project besides Dark Matter's own deliveries (#28):
 * Vendored Skills (shown, never changed) and `skills-lock.json` entries that
 * aren't Project Skills yet, offered for fulfilment from the Library.
 */

/** #30's hook: Imports a lock entry's Skill into the Library and resolves to its key. Null until GitHub Import exists. */
export interface LockImporter {
  importEntry(name: string, entry: ProjectLockEntry): Promise<string>;
}

const run = promisify(execFile);

/** Paths git tracks under `folders` (Project-relative, `/`-separated), or null without git. */
export const gitTrackedPaths = async (project: string, folders: readonly string[]): Promise<Set<string> | null> => {
  try {
    const { stdout } = await run("git", ["-C", project, "ls-files", "-z", "--", ...folders], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(stdout.split("\0").filter(Boolean));
  } catch {
    return null;
  }
};

const isLocalEntry = (entry: ProjectLockEntry) => entry.sourceType === "local" || entry.source.startsWith(".");

/** The Library Skill that fulfils a lock entry: same name and Source, the same `skillPath` preferred. */
export const libraryKeyFor = async (
  library: Library,
  name: string,
  entry: ProjectLockEntry,
): Promise<string | null> => {
  const matches: { key: string; exact: boolean }[] = [];
  for (const [key, libEntry] of Object.entries(library.lock.value.skills).sort(([a], [b]) => a.localeCompare(b))) {
    const { namespace } = splitKey(key);
    const sameSource = isLocalEntry(entry)
      ? namespace === "local"
      : namespace === entry.source || libEntry.source === entry.source;
    if (!sameSource || (await deliveredName(library, key)) !== name) continue;
    matches.push({ key, exact: Boolean(entry.skillPath) && libEntry.skillPath === entry.skillPath });
  }
  return (matches.find((match) => match.exact) ?? matches[0])?.key ?? null;
};

/** The delivered names of a Project's Copies. */
const copyNames = async (library: Library, record: ProjectRecord) => {
  const names = new Set<string>();
  for (const [key, wanted] of Object.entries(record.skills))
    if (wanted.mode === "copy") names.add(await deliveredName(library, key));
  return names;
};

const isDirectory = (path: string) =>
  lstat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

/** Lock entries not yet Project Skills, with the Library Skill that would fulfil each. */
export const lockedSkills = async (
  library: Library,
  project: string,
  record: ProjectRecord,
  importer: LockImporter | null,
): Promise<{ skill: LockedSkill; entry: ProjectLockEntry }[]> => {
  const lock = await readProjectLock(project);
  const ours = await copyNames(library, record);
  const found: { skill: LockedSkill; entry: ProjectLockEntry }[] = [];
  for (const name of Object.keys(lock?.skills ?? {}).sort()) {
    const entry = lockEntry(lock, name);
    if (!entry || ours.has(name)) continue;
    const key = await libraryKeyFor(library, name, entry);
    const message = key || (importer && !isLocalEntry(entry)) ? null : new NotInLibrary(name, entry.source).message;
    found.push({
      entry,
      skill: {
        name,
        source: entry.source,
        sourceType: entry.sourceType ?? "github",
        key,
        present: await isDirectory(join(project, COPY_FOLDER, name)),
        message,
      },
    });
  }
  return found;
};

export const repoSkills = async (
  library: Library,
  project: string,
  record: ProjectRecord,
  importer: LockImporter | null,
): Promise<RepoSkills> => {
  const locked = await lockedSkills(library, project, record, importer);
  const ours = await copyNames(library, record);
  const lockedNames = new Set(locked.map(({ skill }) => skill.name));
  const libraryRoot = join(library.libraryHome, "skills") + sep;
  const { skills: entries, skillFolders } = await scanProject(project, agentAdapters);
  const tracked = await gitTrackedPaths(
    project,
    skillFolders.filter((folder) => folder.exists).map((folder) => folder.path),
  );
  const isTracked = (path: string) => {
    const rel = relative(project, path).split(sep).join("/");
    if (!tracked) return false;
    if (tracked.has(rel)) return true;
    for (const file of tracked) if (file.startsWith(`${rel}/`)) return true;
    return false;
  };
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) groups.set(entry.realPath, [...(groups.get(entry.realPath) ?? []), entry]);
  const vendored: RepoSkills["vendored"] = [];
  for (const [realPath, group] of groups) {
    const first = group[0];
    if (!first || realPath.startsWith(libraryRoot)) continue;
    const copyName = relative(join(project, COPY_FOLDER), realPath);
    if (ours.has(copyName) || lockedNames.has(copyName)) continue;
    if (!group.some((entry) => isTracked(entry.path))) continue;
    vendored.push({
      name: first.name,
      description: first.description,
      paths: group.map((entry) => relative(project, entry.path)).sort(),
    });
  }
  vendored.sort((a, b) => a.name.localeCompare(b.name));
  return { vendored, locked: locked.map(({ skill }) => skill) };
};
