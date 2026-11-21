import { join } from "node:path";
import type { LibraryLockFile, LibrarySkill } from "@dark-matter/contracts";
import { fromHomeRelative } from "./home-path";
import type { OwnedFile } from "./owned-file";
import { readFrontmatter } from "./scanner";
import { computeSkillFolderHash } from "./skill-hash";

/** `<namespace>/<name>` → its parts. Namespaces are `local` or `owner/repo`. */
export const splitKey = (key: string) => {
  const at = key.lastIndexOf("/");
  return { namespace: key.slice(0, at), name: key.slice(at + 1) };
};

/**
 * The Library (#7, ADR-0001): Skills at readable paths under `skills/`
 * (`<owner>/<repo>/<name>/` or `local/<name>/`), provenance in
 * `library-lock.json`, and nothing written inside a Skill folder. A Local
 * Source is a symlink here to the folder it's authored in.
 */
export class Library {
  constructor(
    readonly libraryHome: string,
    private readonly home: string,
    readonly lock: OwnedFile<typeof LibraryLockFile>,
  ) {}

  /** A Skill's folder in the Library, from its key. */
  folder(key: string): string {
    return join(this.libraryHome, "skills", ...key.split("/"));
  }

  /** Every Library Skill; `usage` says how Projects use it (#27). */
  async list(
    usage: ReadonlyMap<string, Pick<LibrarySkill, "projects" | "nameConflict">> = new Map(),
  ): Promise<LibrarySkill[]> {
    const entries = Object.entries(this.lock.value.skills).sort(([a], [b]) => a.localeCompare(b));
    return Promise.all(
      entries.map(async ([key, entry]) => {
        const { namespace, name } = splitKey(key);
        const meta = await readFrontmatter(this.folder(key));
        return {
          key,
          namespace,
          name: meta.name ?? name,
          description: meta.description ?? "",
          localSource: entry.localSource ?? null,
          adoptedFrom: entry.adoptedFrom ?? null,
          modified: await this.modified(key),
          projects: usage.get(key)?.projects ?? 0,
          nameConflict: usage.get(key)?.nameConflict ?? false,
          orphaned: !!entry.orphaned,
        };
      }),
    );
  }

  /**
   * Modified (#34): a Skill from a Source whose files no longer hash to the
   * Library Lock's `computedHash`. `local` Skills and Local Sources have no
   * upstream to differ from, so they're never Modified.
   */
  async modified(key: string): Promise<boolean> {
    const entry = this.lock.value.skills[key];
    if (!entry || entry.localSource || entry.sourceType === "local") return false;
    const hash = await computeSkillFolderHash(this.folder(key)).catch(() => null);
    return hash !== null && hash !== entry.computedHash;
  }

  /** An absolute path from a home-relative one in the lock. */
  absolute(path: string): string {
    return fromHomeRelative(this.home, path);
  }
}
