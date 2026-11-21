import { createHash } from "node:crypto";
import { readFile, readlink, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AdoptOutcome,
  type AdoptPlan,
  type AdoptPlanSkill,
  type ClientKind,
  FindingNotFound,
  type GlobalSkill,
  InvalidOwnedFile,
  type LibraryLockEntry,
  NotAdopted,
  PlanStale,
  type PlanStep,
  type ScanResult,
  SkillNotFound,
  type SymlinkRecord,
} from "@dark-matter/contracts";
import type { ActivityLog } from "./activity";
import { fromHomeRelative, homeRelative } from "./home-path";
import type { Library } from "./library";
import { applySteps, planId } from "./plan";
import { diffSkillFiles } from "./skill-diff";
import { computeSkillFolderHash, fingerprintSkillFolder, readSkillFiles, type SkillFile } from "./skill-hash";
import { editGlobalLock, type GlobalLockEntry, readGlobalLock } from "./skill-lock";

const VISIBILITY_WARNING = (count: number) =>
  `${count === 1 ? "This Skill stops" : `These ${count} Skills stop`} being visible to every Agent everywhere. ` +
  "Agents see a Library Skill again only when a Project adds it.";

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

/** The Namespace a Source gives: `owner/repo` for GitHub (and skills.sh, which resolves to GitHub), else `local`. */
export const namespaceOf = (entry: Pick<GlobalLockEntry, "source" | "sourceType"> | undefined): string =>
  entry && (entry.sourceType ?? "github") === "github" && OWNER_REPO.test(entry.source) ? entry.source : "local";

/** One Skill some planned change is compared against: by content, with its files for a diff. */
interface Known {
  key: string;
  name: string;
  fingerprint: string;
  files: () => Promise<SkillFile[]>;
}

/** Everything a plan needs besides what goes back to the client. */
interface Planned {
  plan: AdoptPlan;
  /** Library Lock entries to add or replace, by key. */
  entries: Record<string, LibraryLockEntry>;
  /** Global lock names to remove. */
  lockRemovals: string[];
  globalLockPath: string | null;
}

export interface AdoptOptions {
  home: string;
  library: Library;
  activity: ActivityLog;
  latestScan: () => ScanResult | null;
  /** A fresh Scan after applying, so the Inbox drops what moved. */
  rescan: () => Promise<unknown>;
  onChange: () => void;
}

/**
 * Adopt (#10): moves Global Skills into the Library, returning a plan (the dry
 * run) before anything is applied. It never deletes a Skill and never uses
 * `trash/`: real folders are moved, symlinks removed, and only byte-for-byte
 * duplicates are merged away. Undo Adopt reverses it from what the Library
 * Lock recorded.
 */
export class Adopt {
  readonly #options: AdoptOptions;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: AdoptOptions) {
    this.#options = options;
  }

  async plan(findings: string[]): Promise<AdoptPlan> {
    return (await this.#plan(findings)).plan;
  }

  apply(findings: string[], expectedPlanId: string, client: ClientKind): Promise<AdoptPlan> {
    return this.#serial(async () => {
      const planned = await this.#plan(findings);
      const { plan } = planned;
      const library = this.#options.library;
      return this.#options.activity.track(
        {
          client,
          action: "adopt.apply",
          subjects: plan.skills.map((skill) => ({ kind: "skill" as const, id: skill.key })),
        },
        async (wrote) => {
          if (plan.planId !== expectedPlanId) throw new PlanStale();
          this.#assertLockWritable();
          await applySteps(plan.steps, {
            home: this.#options.home,
            libraryHome: library.libraryHome,
            wrote,
            editFile: async (step) => {
              if (step.kind !== "editFile") return [];
              if (fromHomeRelative(this.#options.home, step.path) === library.lock.path) {
                const path = await library.lock.update((current) => ({
                  ...current,
                  skills: { ...current.skills, ...planned.entries },
                }));
                return path ? [path] : [];
              }
              if (planned.globalLockPath && step.backup) {
                return editGlobalLock(
                  planned.globalLockPath,
                  fromHomeRelative(this.#options.home, step.backup),
                  (skills) => {
                    for (const name of planned.lockRemovals) delete skills[name];
                  },
                );
              }
              return [];
            },
          });
          this.#options.onChange();
          await this.#options.rescan();
          return plan;
        },
      );
    });
  }

  undo(key: string, client: ClientKind): Promise<void> {
    return this.#serial(() =>
      this.#options.activity.track(
        { client, action: "adopt.undo", subjects: [{ kind: "skill", id: key }] },
        async (wrote) => {
          const library = this.#options.library;
          const entry = library.lock.value.skills[key];
          if (!entry) throw new SkillNotFound(key);
          if (!entry.adoptedFrom) throw new NotAdopted(key);
          this.#assertLockWritable();
          const rel = (path: string) => homeRelative(this.#options.home, path);
          const folder = rel(library.folder(key));
          const steps: PlanStep[] = [];
          if (entry.localSource) {
            steps.push({ kind: "removeLink", path: folder, target: library.absolute(entry.localSource) });
          } else {
            steps.push({ kind: "move", from: folder, to: entry.adoptedFrom });
            for (const copy of entry.adoptedCopies ?? [])
              steps.push({ kind: "copy", from: entry.adoptedFrom, to: copy });
          }
          for (const link of entry.adoptedLinks ?? []) steps.push({ kind: "createLink", ...link });
          const restore = entry.skillLockEntry;
          if (restore) steps.push({ kind: "editFile", path: restore.path, change: `restore ${restore.name}` });
          steps.push({ kind: "editFile", path: rel(library.lock.path), change: `remove ${key}` });
          await applySteps(steps, {
            home: this.#options.home,
            libraryHome: library.libraryHome,
            wrote,
            editFile: async (step) => {
              if (step.kind !== "editFile") return [];
              if (restore && step.path === restore.path) {
                const path = library.absolute(restore.path);
                return editGlobalLock(path, await backupPath(library.libraryHome, path), (skills) => {
                  skills[restore.name] ??= restore.entry;
                });
              }
              const path = await library.lock.update((current) => {
                const { [key]: _removed, ...skills } = current.skills;
                return { ...current, skills };
              });
              return path ? [path] : [];
            },
          });
          this.#options.onChange();
          await this.#options.rescan();
        },
      ),
    );
  }

  #assertLockWritable() {
    const problem = this.#options.library.lock.problem;
    if (problem) throw new InvalidOwnedFile(problem.path, problem.message);
  }

  async #plan(ids: string[]): Promise<Planned> {
    const { home, library } = this.#options;
    const rel = (path: string) => homeRelative(home, path);
    const scan = this.#options.latestScan();
    const findings = [...new Set(ids)].map((id) => {
      const finding = scan?.globalSkills.find((skill) => skill.id === id);
      if (!finding) throw new FindingNotFound(id);
      return finding;
    });
    const globalLock = await readGlobalLock(home);
    const agentsFolder = rel(join(home, ".agents/skills"));

    // Everything a new Skill is compared with: the Library first, then this Adopt as it's planned.
    const byKey = new Map<string, Known>();
    const byName = new Map<string, Known[]>();
    const remember = (known: Known) => {
      byKey.set(known.key, known);
      byName.set(known.name, [...(byName.get(known.name) ?? []), known]);
    };
    for (const [key, entry] of Object.entries(library.lock.value.skills)) {
      const folder = library.folder(key);
      const fingerprint = await fingerprintSkillFolder(folder).catch(() => `missing:${entry.computedHash}`);
      remember({ key, name: basename(entry.adoptedFrom ?? key), fingerprint, files: () => readSkillFiles(folder) });
    }

    const moves: PlanStep[] = [];
    const removals: PlanStep[] = [];
    const skills: AdoptPlanSkill[] = [];
    const entries: Record<string, LibraryLockEntry> = {};
    const lockRemovals: string[] = [];

    for (const finding of findings) {
      const real = fromHomeRelative(home, finding.realPath);
      if ((await realpath(real).catch(() => null)) !== real) throw new PlanStale();
      const name = basename(real);
      const files = await readSkillFiles(real);
      const fingerprint = await fingerprintSkillFolder(real);
      const computedHash = await computeSkillFolderHash(real);
      const lockName = finding.locations
        .filter((location) => location.folder === agentsFolder)
        .map((location) => basename(location.path))
        .find((candidate) => globalLock?.entries[candidate] !== undefined);
      const lockEntry = lockName ? globalLock?.entries[lockName] : undefined;
      const namespace = finding.localSource ? "local" : namespaceOf(lockEntry);
      const links = await symlinksOf(finding, home);

      const sameName = byName.get(name) ?? [];
      const twin = finding.localSource ? undefined : sameName.find((known) => known.fingerprint === fingerprint);
      const differs = sameName.find((known) => known.fingerprint !== fingerprint);
      let key = `${namespace}/${name}`;
      let outcome: AdoptOutcome = finding.localSource ? "localSource" : "moved";
      if (twin) {
        key = twin.key;
        outcome = "merged";
      } else if (byKey.has(key)) {
        key = `${namespace}/${name}-${computedHash.slice(0, 7)}`;
        if (byKey.has(key)) throw new PlanStale();
        outcome = "variant";
      } else if (differs) outcome = "variant";
      const diff = differs
        ? {
            against: differs.key,
            patch: diffSkillFiles(await differs.files(), files, { a: differs.key, b: key }),
          }
        : null;
      skills.push({
        finding: finding.id,
        name,
        key,
        namespace: key.slice(0, key.lastIndexOf("/")),
        outcome: twin ? "merged" : outcome,
        computedHash,
        diff: twin ? null : diff,
      });

      const destination = rel(library.folder(key));
      for (const link of links) removals.push({ kind: "removeLink", ...link });
      const skillLockEntry =
        lockName && globalLock?.raw[lockName]
          ? { path: rel(globalLock.path), name: lockName, entry: globalLock.raw[lockName] }
          : undefined;
      if (lockName) lockRemovals.push(lockName);

      if (twin) {
        // The same bytes are already in the Library (or moving there now): this copy merges into it.
        removals.push({ kind: "removeCopy", path: finding.realPath, sameAs: destination });
        const into = entries[key] ?? library.lock.value.skills[key];
        if (into) {
          entries[key] = {
            ...into,
            adoptedCopies: [...(into.adoptedCopies ?? []), finding.realPath],
            adoptedLinks: [...(into.adoptedLinks ?? []), ...links],
          };
        }
        continue;
      }

      const provenance = lockEntry && namespace !== "local" ? sourceFields(lockEntry) : null;
      if (finding.localSource) {
        moves.push({ kind: "createLink", path: destination, target: real });
        entries[key] = {
          source: finding.realPath,
          sourceType: "local",
          computedHash,
          localSource: finding.realPath,
          adoptedFrom: links[0]?.path ?? finding.realPath,
          ...(links.length > 0 && { adoptedLinks: links }),
        };
      } else {
        moves.push({ kind: "move", from: finding.realPath, to: destination });
        entries[key] = {
          ...(provenance ?? { source: finding.realPath, sourceType: "local" }),
          computedHash,
          adoptedFrom: finding.realPath,
          ...(links.length > 0 && { adoptedLinks: links }),
          ...(skillLockEntry && { skillLockEntry }),
        };
      }
      remember({ key, name, fingerprint, files: async () => files });
    }

    const steps: PlanStep[] = [
      ...moves,
      {
        kind: "editFile",
        path: rel(library.lock.path),
        change: `record provenance for ${Object.keys(entries).sort().join(", ")}`,
      },
      ...removals,
    ];
    let globalLockPath: string | null = null;
    if (globalLock && lockRemovals.length > 0) {
      globalLockPath = globalLock.path;
      steps.push({
        kind: "editFile",
        path: rel(globalLock.path),
        change: `remove ${lockRemovals.sort().join(", ")}`,
        backup: rel(await backupPath(library.libraryHome, globalLock.path)),
      });
    }

    const body = {
      findings: findings.map((finding) => finding.id),
      skills,
      steps,
      warnings: [VISIBILITY_WARNING(new Set(skills.map((skill) => skill.key)).size)],
    };
    return {
      plan: { planId: planId({ ...body, entries }), ...body },
      entries,
      lockRemovals,
      globalLockPath,
    };
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }
}

/** Where a copy of the global lock goes before Dark Matter edits it: named by its content, so plans stay stable. */
const backupPath = async (libraryHome: string, lockPath: string) => {
  const text = await readFile(lockPath).catch(() => Buffer.alloc(0));
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return join(libraryHome, "backups", `skill-lock.${digest}.json`);
};

/** The skills-lock v2 fields a global lock entry carries over into the Library Lock. */
const sourceFields = (entry: GlobalLockEntry) => ({
  source: entry.source,
  sourceType: entry.sourceType ?? "github",
  ...(entry.ref && { ref: entry.ref }),
  ...(entry.commit && { commit: entry.commit }),
  ...(entry.skillPath && { skillPath: entry.skillPath }),
});

/** The finding's global symlinks, with their link text as it is now. */
const symlinksOf = async (finding: GlobalSkill, home: string): Promise<SymlinkRecord[]> =>
  Promise.all(
    finding.locations
      .filter((location) => location.symlink)
      .map(async (location) => ({
        path: location.path,
        target: await readlink(fromHomeRelative(home, location.path)),
      })),
  );
