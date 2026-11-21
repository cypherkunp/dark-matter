import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InvalidSkillsLock, type LibraryLockEntry } from "@dark-matter/contracts";
import { z } from "zod";
import { writeFileAtomic } from "./atomic";
import { splitKey } from "./library";

/**
 * A Project's `skills-lock.json` (version 2), the committed record of its
 * Copies (#28). Written exactly as the `skills` CLI 1.9.0 writes it
 * (`writeLocalLockUnlocked`): `{version, skills}` with skills sorted by name
 * (`Array.prototype.sort`), 2-space JSON plus a newline, no timestamps,
 * atomically. Entries Dark Matter didn't write are kept as they are.
 */
export const projectLockPath = (project: string) => join(project, "skills-lock.json");

/** The folder a Copy lives in, Project-relative; `.claude/skills/<name>` links to it. */
export const COPY_FOLDER = ".agents/skills";

const LockShape = z.looseObject({
  version: z.number(),
  skills: z.record(z.string(), z.looseObject({})),
});

/** One entry as read: only `source` and `computedHash` matter to Dark Matter. */
export const ProjectLockEntry = z.looseObject({
  source: z.string().min(1),
  sourceType: z.string().optional().catch(undefined),
  ref: z.string().optional().catch(undefined),
  commit: z.string().optional().catch(undefined),
  skillPath: z.string().optional().catch(undefined),
  computedHash: z.string().catch(""),
});
export type ProjectLockEntry = z.infer<typeof ProjectLockEntry>;

export interface ProjectLock {
  version: number;
  /** Every entry as written, by installed name. */
  skills: Record<string, Record<string, unknown>>;
}

/** The Project's lock, `null` when there is none. Throws `InvalidSkillsLock` rather than treating a bad file as empty. */
export const readProjectLock = async (project: string): Promise<ProjectLock | null> => {
  const path = projectLockPath(project);
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new InvalidSkillsLock(path, (error as Error).message);
  }
  const lock = LockShape.safeParse(json);
  if (!lock.success) throw new InvalidSkillsLock(path, "no version or skills map");
  return { version: lock.data.version, skills: lock.data.skills };
};

/** An entry, parsed leniently, or null when it isn't usable. */
export const lockEntry = (lock: ProjectLock | null, name: string): ProjectLockEntry | null => {
  const parsed = ProjectLockEntry.safeParse(lock?.skills[name]);
  return parsed.success ? parsed.data : null;
};

/** The file's text for `lock`, byte for byte what the `skills` CLI writes. */
export const projectLockText = (lock: ProjectLock): string => {
  const skills = Object.fromEntries(
    Object.keys(lock.skills)
      .sort()
      .map((name) => [name, lock.skills[name]]),
  );
  return `${JSON.stringify({ version: lock.version, skills }, null, 2)}\n`;
};

export const writeProjectLock = (project: string, lock: ProjectLock) =>
  writeFileAtomic(projectLockPath(project), projectLockText(lock));

/**
 * The lock entry for a Copy of a Library Skill, with fields in the CLI's own
 * order (`projectLockEntry`): source, ref, commit, sourceType, skillPath,
 * computedHash. The Source is the Namespace: a `local` Skill points at its own
 * committed folder (the CLI's portable `./` form), so a teammate's
 * `npx skills experimental_install` finds it in place.
 */
export const copyLockEntry = (
  key: string,
  library: Pick<LibraryLockEntry, "source" | "sourceType" | "ref" | "commit" | "skillPath"> | undefined,
  name: string,
  computedHash: string,
): Record<string, unknown> => {
  const { namespace } = splitKey(key);
  if (namespace === "local") return { source: `./${COPY_FOLDER}/${name}`, sourceType: "local", computedHash };
  const same = library?.source === namespace;
  return {
    source: namespace,
    ...(same && library?.ref && { ref: library.ref }),
    ...(same && library?.commit && { commit: library.commit }),
    sourceType: same && library?.sourceType ? library.sourceType : "github",
    ...(same && library?.skillPath && { skillPath: library.skillPath }),
    computedHash,
  };
};
