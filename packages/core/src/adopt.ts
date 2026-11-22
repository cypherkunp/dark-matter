import { createHash } from "node:crypto";
import { readFile, readlink, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AdoptOutcome,
  type AdoptPlan,
  type AdoptPlanSkill,
  type AgentId,
  type ClientKind,
  FindingNotFound,
  type GlobalSkill,
  InvalidOwnedFile,
  type LibraryLockEntry,
  NotAdoptable,
  NotAdopted,
  PlanStale,
  type PlanStep,
  type ScanResult,
  type SkillDeleteImpact,
  SkillNotFound,
  type SymlinkRecord,
  type UndoAdoptPlan,
  type UntrackedSkill,
} from "@dark-matter/contracts";
import type { ActivityLog, Wrote } from "./activity";
import { fromHomeRelative, homeRelative } from "./home-path";
import type { Library } from "./library";
import { applySteps, planId } from "./plan";
import { readFrontmatter } from "./scanner";
import { diffSkillFiles } from "./skill-diff";
import { computeSkillFolderHash, fingerprintSkillFolder, readSkillFiles, type SkillFile } from "./skill-hash";
import { editGlobalLock, type GlobalLockEntry, projectLockSources, readGlobalLock } from "./skill-lock";
import { WriteQueue } from "./write-queue";

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

/** An Adopted untracked Skill (#29) whose Link goes back into its Project, On. */
export interface KeepLink {
  /** The Project, absolute. */
  project: string;
  key: string;
  /** The folder name it's delivered under (its SKILL.md `name`). */
  name: string;
  /** Project-relative skill folders it was found in. */
  folders: string[];
  /** Absolute paths the Adopt itself empties (the found entries), so a Link can go there. */
  freed: string[];
}

/** Adopt & keep Link (#29): Project delivery puts Links back for Adopted untracked Skills. */
export interface KeepLinks {
  /** The steps and warnings shown in the dry run. Throws `NameConflict` when a Link can't go back. */
  plan(
    links: readonly KeepLink[],
  ): Promise<{ steps: PlanStep[]; warnings: string[]; addedAgents: { project: string; agent: AgentId }[] }>;
  /** Adds each as a Project Skill (Link, On) and delivers it, after the Adopt's own steps. */
  apply(links: readonly KeepLink[], wrote: Wrote): Promise<void>;
  /** Undo Adopt: the Project forgets the Project Skill and its Links go, before the folder moves back. */
  release(project: string, key: string, wrote: Wrote): Promise<void>;
  /** Undo Adopt: takes Agents the Adopt added back out of a Project, re-delivering it. */
  removeAgents(project: string, agents: readonly AgentId[], wrote: Wrote): Promise<void>;
}

/** A Global Skill or an untracked Project Skill (with its Project), as Adopt plans it. */
type Finding = Pick<
  GlobalSkill,
  "id" | "realPath" | "locations" | "localSource" | "adoptable" | "notAdoptableReason"
> & { project: string | null };

/** Everything a plan needs besides what goes back to the client. */
interface Planned {
  plan: AdoptPlan;
  /** The Adopt's own steps; `plan.steps` adds the Links put back. */
  adoptSteps: PlanStep[];
  keep: KeepLink[];
  /** Library Lock entries to add or replace, by key. */
  entries: Record<string, LibraryLockEntry>;
  /** Global lock names to remove. */
  lockRemovals: string[];
  globalLockPath: string | null;
}

export interface AdoptOptions {
  /** The core's one write queue (review #8); a queue of its own when left out (tests). */
  writes?: WriteQueue;
  home: string;
  library: Library;
  activity: ActivityLog;
  /** The latest Scan, its findings' `adoptable` from the current settings: Adopt refuses the rest (ADR-0007). */
  latestScan: () => ScanResult | null;
  /** A fresh Scan after applying, so the Inbox drops what moved. */
  rescan: () => Promise<unknown>;
  onChange: () => void;
  /** Untracked Project Skills from the latest Scan (#29), `adoptable` from the current settings. */
  untracked?: () => UntrackedSkill[];
  keepLinks?: KeepLinks;
  /** The Projects using a Library Skill, for Undo Adopt's plan. */
  usage?: (key: string) => Promise<SkillDeleteImpact[]>;
  /** Removes every Link to a Library Skill (and its Project records) before Undo Adopt moves it back. */
  release?: (key: string, wrote: Wrote) => Promise<void>;
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
  readonly #ownWrites = new WriteQueue();

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
          subjects: [
            ...plan.skills.map((skill) => ({ kind: "skill" as const, id: skill.key })),
            ...[...new Set(planned.keep.map((link) => link.project))].map((id) => ({ kind: "project" as const, id })),
          ],
        },
        async (wrote) => {
          if (plan.planId !== expectedPlanId) throw new PlanStale();
          this.#assertLockWritable();
          await applySteps(planned.adoptSteps, {
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
            // A failure partway reverses every completed step (review #7); the lock is re-read from disk then.
            restored: async () => void (await library.lock.reload()),
            finish: async () => {
              if (planned.keep.length > 0) await this.#options.keepLinks?.apply(planned.keep, wrote);
            },
          });
          this.#options.onChange();
          await this.#options.rescan();
          return plan;
        },
      );
    });
  }

  async undoPlan(key: string): Promise<UndoAdoptPlan> {
    const entry = this.#options.library.lock.value.skills[key];
    if (!entry) throw new SkillNotFound(key);
    if (!entry.adoptedFrom) throw new NotAdopted(key);
    return { key, adoptedFrom: entry.adoptedFrom, projects: (await this.#options.usage?.(key)) ?? [] };
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
          // Every Link to it goes first, not only the ones Adopt kept (Copies stay as committed files).
          for (const project of entry.keptLinks ?? [])
            await this.#options.keepLinks?.release(library.absolute(project), key, wrote);
          await this.#options.release?.(key, wrote);
          // Agents this Adopt added go, unless another Adopted Skill still needs them there.
          const others = Object.entries(library.lock.value.skills).filter(([other]) => other !== key);
          for (const project of new Set((entry.keptAgents ?? []).map((kept) => kept.project))) {
            const agents = (entry.keptAgents ?? [])
              .filter((kept) => kept.project === project)
              .map((kept) => kept.agent as AgentId)
              .filter(
                (agent) =>
                  !others.some(([, other]) =>
                    (other.keptAgents ?? []).some((kept) => kept.project === project && kept.agent === agent),
                  ),
              );
            if (agents.length > 0)
              await this.#options.keepLinks?.removeAgents(library.absolute(project), agents, wrote);
          }
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
    const untracked = this.#options.untracked?.() ?? [];
    const findings = [...new Set(ids)].map((id): Finding => {
      const global = scan?.globalSkills.find((skill) => skill.id === id);
      if (global) return { ...global, project: null };
      const found = untracked.find((skill) => skill.id === id);
      if (found) return found;
      throw new FindingNotFound(id);
    });
    // Refused in the core, not only hidden in the app (ADR-0007). Undo Adopt never asks.
    for (const finding of findings)
      if (!finding.adoptable) throw new NotAdoptable(finding.id, finding.notAdoptableReason ?? "adoptPermissionOff");
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
    const keep: KeepLink[] = [];

    for (const finding of findings) {
      const real = fromHomeRelative(home, finding.realPath);
      if ((await realpath(real).catch(() => null)) !== real) throw new PlanStale();
      const name = basename(real);
      const files = await readSkillFiles(real);
      const fingerprint = await fingerprintSkillFolder(real);
      const computedHash = await computeSkillFolderHash(real);
      // A Global Skill's Source is in the global lock (and dropped from it); a Project's in its skills-lock.json.
      const lockName = finding.project
        ? undefined
        : finding.locations
            .filter((location) => location.folder === agentsFolder)
            .map((location) => basename(location.path))
            .find((candidate) => globalLock?.entries[candidate] !== undefined);
      const projectLock = finding.project ? await projectLockSources(finding.project) : {};
      const lockEntry = lockName
        ? globalLock?.entries[lockName]
        : finding.locations.map((location) => projectLock[basename(location.path)]).find(Boolean);
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
      const keptLinks = finding.project ? [rel(finding.project)] : [];
      if (finding.project) {
        keep.push({
          project: finding.project,
          key,
          name: (await readFrontmatter(real)).name ?? name,
          folders: [...new Set(finding.locations.map((location) => location.folder))],
          freed: finding.locations.map((location) => fromHomeRelative(home, location.path)),
        });
      }

      if (twin) {
        // The same bytes are already in the Library (or moving there now): this copy merges into it.
        removals.push({ kind: "removeCopy", path: finding.realPath, sameAs: destination });
        const into = entries[key] ?? library.lock.value.skills[key];
        if (into) {
          entries[key] = {
            ...into,
            adoptedCopies: [...(into.adoptedCopies ?? []), finding.realPath],
            adoptedLinks: [...(into.adoptedLinks ?? []), ...links],
            ...((into.keptLinks || keptLinks.length > 0) && {
              keptLinks: [...new Set([...(into.keptLinks ?? []), ...keptLinks])],
            }),
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
          ...(keptLinks.length > 0 && { keptLinks }),
        };
      } else {
        moves.push({ kind: "move", from: finding.realPath, to: destination });
        entries[key] = {
          ...(provenance ?? { source: finding.realPath, sourceType: "local" }),
          computedHash,
          adoptedFrom: finding.realPath,
          ...(links.length > 0 && { adoptedLinks: links }),
          ...(skillLockEntry && { skillLockEntry }),
          ...(keptLinks.length > 0 && { keptLinks }),
        };
      }
      remember({ key, name, fingerprint, files: async () => files });
    }

    const adoptSteps: PlanStep[] = [
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
      adoptSteps.push({
        kind: "editFile",
        path: rel(globalLock.path),
        change: `remove ${lockRemovals.sort().join(", ")}`,
        backup: rel(await backupPath(library.libraryHome, globalLock.path)),
      });
    }

    const kept =
      keep.length > 0 && this.#options.keepLinks
        ? await this.#options.keepLinks.plan(keep)
        : { steps: [] as PlanStep[], warnings: [] as string[], addedAgents: [] };
    // Undo Adopt takes the Agents it added back out of the Project (review #17).
    for (const link of keep) {
      const added = kept.addedAgents.filter((agent) => agent.project === link.project);
      const entry = entries[link.key];
      if (entry && added.length > 0)
        entries[link.key] = {
          ...entry,
          keptAgents: [
            ...(entry.keptAgents ?? []),
            ...added.map(({ agent }) => ({ project: rel(link.project), agent })),
          ],
        };
    }
    const globalKeys = new Set(skills.filter((_, at) => findings[at]?.project === null).map((skill) => skill.key));
    const body = {
      findings: findings.map((finding) => finding.id),
      skills,
      steps: [...adoptSteps, ...kept.steps],
      warnings: [...(globalKeys.size > 0 ? [VISIBILITY_WARNING(globalKeys.size)] : []), ...kept.warnings],
    };
    return {
      plan: { planId: planId({ ...body, entries }), ...body },
      adoptSteps,
      keep,
      entries,
      lockRemovals,
      globalLockPath,
    };
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    return (this.#options.writes ?? this.#ownWrites).run(task);
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
const symlinksOf = async (finding: Pick<GlobalSkill, "locations">, home: string): Promise<SymlinkRecord[]> =>
  Promise.all(
    finding.locations
      .filter((location) => location.symlink)
      .map(async (location) => ({
        path: location.path,
        target: await readlink(fromHomeRelative(home, location.path)),
      })),
  );
