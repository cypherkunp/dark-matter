import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type ActivityClient,
  type AppliedUpdates,
  type ApplyUpdatesInput,
  type CheckUpdatesInput,
  type DetachResult,
  ImportSkillNotFound,
  InvalidOwnedFile,
  type LibraryLockEntry,
  NoUpdate,
  type OrphanedSkill,
  type PlanStep,
  RateLimited,
  type RepointInput,
  SkillModified,
  SkillNotFound,
  type SkillUpdate,
  type UpdateDiff,
  type UpdatesView,
} from "@dark-matter/contracts";
import type { ActivityLog, Wrote } from "./activity";
import type { Clock } from "./clock";
import { GitHubNotFound, type GitHubSession } from "./github";
import { homeRelative } from "./home-path";
import { parseImportSource } from "./import-source";
import { type FetchedSource, type Importer, installedName, installFetched, skillPathOf } from "./importer";
import { type Library, splitKey } from "./library";
import { type KeyRenameHook, removeEmptyFolders } from "./namespace-rename";
import { applySteps } from "./plan";
import type { DailyJob } from "./scheduler";
import { diffSkillFiles } from "./skill-diff";
import { computeSkillFolderHash, readSkillFiles } from "./skill-hash";
import type { SourceChecks, SourceRef } from "./source-check";
import type { Trash } from "./trash";

export interface UpdatesOptions {
  home: string;
  library: Library;
  importer: Importer;
  activity: ActivityLog;
  checks: SourceChecks;
  cache: DatabaseSync;
  clock: Clock;
  trash: Trash;
  /** What follows a Skill to its new key on Detach (Links, Copies, Collections). */
  hooks: readonly KeyRenameHook[];
  onChange: () => void;
}

/** The repo folder a Library Lock entry's `skillPath` names. */
const folderOf = (entry: LibraryLockEntry) => (entry.skillPath ? posix.dirname(entry.skillPath) : ".");

/** Follows its ref: an Imported GitHub Skill whose ref is a branch (a tag or commit only moves when re-pointed). */
const tracked = (entry: LibraryLockEntry): entry is LibraryLockEntry & { ref: string } =>
  entry.sourceType === "github" &&
  !entry.localSource &&
  !!entry.ref &&
  entry.refType !== "tag" &&
  !/^[0-9a-f]{40}$/.test(entry.ref);

const sourceId = ({ source, ref }: SourceRef) => `${source.toLowerCase()}@${ref}`;

/**
 * Updates for Imported Skills (#33, decided in #11 points 5–8 and 10).
 * Checks run per Source from the daily run and Check for updates; nothing is
 * ever applied without you. Applying replaces the Library folder, so every
 * Link gets it, and Copies pinned to the old commit show as outdated.
 */
export class Updates {
  readonly #options: UpdatesOptions;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: UpdatesOptions) {
    this.#options = options;
  }

  /** Library Skills that follow a Source, grouped by Source and ref. */
  #sources(keys?: readonly string[]): Map<string, SourceRef & { keys: string[] }> {
    const skills = this.#options.library.lock.value.skills;
    const wanted = keys ? new Set(keys) : null;
    const pickedSources = wanted
      ? new Set(
          [...wanted].map((key) => {
            const entry = skills[key];
            if (!entry) throw new SkillNotFound(key);
            return entry.sourceType === "github" && entry.ref ? sourceId({ source: entry.source, ref: entry.ref }) : "";
          }),
        )
      : null;
    const groups = new Map<string, SourceRef & { keys: string[] }>();
    for (const [key, entry] of Object.entries(skills).sort(([a], [b]) => a.localeCompare(b))) {
      if (!tracked(entry)) continue;
      const id = sourceId({ source: entry.source, ref: entry.ref });
      if (pickedSources && !pickedSources.has(id)) continue;
      const group = groups.get(id) ?? { source: entry.source, ref: entry.ref, keys: [] };
      group.keys.push(key);
      groups.set(id, group);
    }
    return groups;
  }

  /** Check for updates: every Source, or those of `keys` (the Skill page's Check upstream). */
  check({ keys }: CheckUpdatesInput, client: ActivityClient): Promise<UpdatesView> {
    return this.#serial(async () => {
      const { activity, importer } = this.#options;
      const groups = this.#sources(keys);
      await activity.track(
        {
          client,
          action: "importer.checkUpdates",
          subjects: [...groups.values()].map((group) => ({ kind: "source" as const, id: group.source })),
        },
        async (wrote) => {
          const session = await importer.options.github.session();
          const orphaned = new Map<string, string | null>();
          let failure: unknown = null;
          for (const group of groups.values()) {
            try {
              await this.#checkSource(session, group, orphaned);
            } catch (error) {
              if (error instanceof GitHubNotFound) {
                for (const key of group.keys) orphaned.set(key, `${group.source} can't be found on GitHub`);
                this.#saveUpdates(group, []);
              } else {
                failure ??= error;
                // Every later Source would fail the same way.
                if (error instanceof RateLimited) break;
              }
            }
          }
          await this.#markOrphaned(orphaned, wrote);
          if (failure) throw failure;
        },
      );
      this.#options.onChange();
      return this.view();
    });
  }

  async #checkSource(
    session: GitHubSession,
    group: SourceRef & { keys: string[] },
    orphaned: Map<string, string | null>,
  ): Promise<void> {
    const { checks, library } = this.#options;
    const head = await checks.head(session, group);
    const now = this.#options.clock.now().toISOString();
    const updates: SkillUpdate[] = [];
    for (const key of group.keys) {
      const entry = library.lock.value.skills[key];
      if (!entry) continue;
      if (entry.commit === head && entry.skillFolderHash) {
        orphaned.set(key, null);
        continue;
      }
      const folder = folderOf(entry);
      const atHead = (await checks.folders(session, group, head)).folders.get(folder);
      if (!atHead) {
        orphaned.set(key, `${folder} is gone from ${group.source}@${group.ref}`);
        continue;
      }
      orphaned.set(key, null);
      // Adopted Skills have no folder SHA yet: their pinned commit's tree has it.
      const baseline =
        entry.skillFolderHash ??
        (entry.commit ? (await checks.folders(session, group, entry.commit)).folders.get(folder) : undefined);
      if (atHead === baseline || atHead === entry.skippedUpdate) continue;
      updates.push({
        key,
        source: group.source,
        ref: group.ref,
        commit: entry.commit ?? null,
        head,
        folderSha: atHead,
        modified: false,
        checkedAt: now,
      });
    }
    this.#saveUpdates(group, updates);
  }

  #saveUpdates(group: SourceRef, updates: SkillUpdate[]) {
    const { cache } = this.#options;
    cache.prepare("DELETE FROM skill_updates WHERE lower(source) = lower(?) AND ref = ?").run(group.source, group.ref);
    const insert = cache.prepare('INSERT INTO skill_updates (key, source, ref, "update") VALUES (?, ?, ?, ?)');
    for (const update of updates) insert.run(update.key, update.source, update.ref, JSON.stringify(update));
  }

  #dropUpdate(key: string) {
    this.#options.cache.prepare("DELETE FROM skill_updates WHERE key = ?").run(key);
  }

  /** Writes Orphaned markers that changed (a reason, or null to clear one). */
  async #markOrphaned(orphaned: Map<string, string | null>, wrote: Wrote) {
    const { library } = this.#options;
    const changed = [...orphaned].filter(([key, reason]) => {
      const entry = library.lock.value.skills[key];
      return entry && (entry.orphaned ?? null) !== reason;
    });
    if (changed.length === 0) return;
    this.#assertLockReadable();
    wrote(
      await library.lock.update((current) => {
        const skills = { ...current.skills };
        for (const [key, reason] of changed) {
          const entry = skills[key];
          if (!entry) continue;
          const { orphaned: _old, ...rest } = entry;
          skills[key] = reason ? { ...rest, orphaned: reason } : rest;
        }
        return { ...current, skills };
      }),
    );
  }

  #assertLockReadable() {
    const { problem } = this.#options.library.lock;
    if (problem) throw new InvalidOwnedFile(problem.path, problem.message);
  }

  /** A waiting update that still applies to the Library as it is now. */
  #update(key: string): SkillUpdate | null {
    const row = this.#options.cache.prepare('SELECT "update" FROM skill_updates WHERE key = ?').get(key) as
      | { update: string }
      | undefined;
    if (!row) return null;
    const update = JSON.parse(row.update) as SkillUpdate;
    const entry = this.#options.library.lock.value.skills[key];
    if (
      !entry ||
      !tracked(entry) ||
      entry.source.toLowerCase() !== update.source.toLowerCase() ||
      entry.ref !== update.ref ||
      entry.skillFolderHash === update.folderSha ||
      entry.skippedUpdate === update.folderSha
    ) {
      return null;
    }
    return update;
  }

  /** The Updates list: waiting updates, Orphaned Skills, each Source's last check and GitHub's status. */
  async view(): Promise<UpdatesView> {
    const { cache, library, checks } = this.#options;
    const keys = (cache.prepare("SELECT key FROM skill_updates ORDER BY key").all() as { key: string }[]).map(
      (row) => row.key,
    );
    const updates: SkillUpdate[] = [];
    for (const key of keys) {
      const update = this.#update(key);
      if (update) updates.push({ ...update, modified: await library.modified(key) });
    }
    const orphaned: OrphanedSkill[] = Object.entries(library.lock.value.skills)
      .filter(([, entry]) => entry.orphaned)
      .map(([key, entry]) => ({ key, source: entry.source, reason: entry.orphaned ?? "" }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return { updates, orphaned, sources: checks.statuses(), github: checks.github() };
  }

  async #fetchAt(session: GitHubSession, source: SourceRef, commit: string): Promise<FetchedSource> {
    return this.#options.importer.fetch(
      session,
      { fullName: source.source, ref: source.ref, refType: "branch", subpath: null, skill: null },
      commit,
    );
  }

  /** The diff between the Library's folder and the waiting upstream version. */
  async diff(key: string): Promise<UpdateDiff> {
    const update = this.#update(key);
    if (!update) throw new NoUpdate(key);
    const entry = this.#options.library.lock.value.skills[key];
    const session = await this.#options.importer.options.github.session();
    const fetched = await this.#fetchAt(session, update, update.head);
    try {
      const upstream = join(fetched.checkout, ...(entry ? folderOf(entry) : ".").split("/"));
      const patch = diffSkillFiles(
        await readSkillFiles(this.#options.library.folder(key)),
        await readSkillFiles(upstream),
        { a: "Library", b: `${update.source}@${update.head.slice(0, 7)}` },
      );
      return { key, patch };
    } finally {
      await fetched.dispose();
    }
  }

  /**
   * Applies updates per Skill (the Updates list's Update, Update all and the
   * Modified choices). A Modified Skill without a choice is refused.
   */
  apply({ updates }: ApplyUpdatesInput, client: ActivityClient): Promise<AppliedUpdates> {
    return this.#serial(async () => {
      const { library } = this.#options;
      const planned: { key: string; update: SkillUpdate; choice: "takeUpstream" | "keepMine" | "detach" | null }[] = [];
      for (const { key, choice } of updates) {
        if (!library.lock.value.skills[key]) throw new SkillNotFound(key);
        const update = this.#update(key);
        if (!update) throw new NoUpdate(key);
        const modified = await library.modified(key);
        if (modified && !choice) throw new SkillModified(key);
        planned.push({ key, update, choice: modified ? (choice ?? null) : null });
      }
      const skills: AppliedUpdates["skills"] = [];
      for (const { key, update, choice } of planned) {
        if (choice === "keepMine") {
          await this.#keepMine(key, update, client);
          skills.push({ key, outcome: "kept", newKey: key });
        } else if (choice === "detach") {
          const { newKey } = await this.#detach(key, client);
          skills.push({ key, outcome: "detached", newKey });
        } else {
          await this.#takeUpstream(key, update, choice === "takeUpstream", client);
          skills.push({ key, outcome: "updated", newKey: key });
        }
      }
      this.#options.onChange();
      return { skills };
    });
  }

  #keepMine(key: string, update: SkillUpdate, client: ActivityClient) {
    const { activity, library } = this.#options;
    return activity.track(
      { client, action: "importer.keepMine", subjects: [{ kind: "skill", id: key }] },
      async (wrote) => {
        this.#assertLockReadable();
        wrote(
          await library.lock.update((current) => {
            const entry = current.skills[key];
            if (!entry) throw new SkillNotFound(key);
            return { ...current, skills: { ...current.skills, [key]: { ...entry, skippedUpdate: update.folderSha } } };
          }),
        );
        this.#dropUpdate(key);
      },
    );
  }

  /** Replaces the Library folder with the upstream version at the update's head; yours goes to `trash/` if `trashMine`. */
  #takeUpstream(key: string, update: SkillUpdate, trashMine: boolean, client: ActivityClient) {
    const { activity, library } = this.#options;
    const entry = library.lock.value.skills[key];
    if (!entry) throw new SkillNotFound(key);
    return activity.track(
      {
        client,
        action: "importer.applyUpdate",
        subjects: [
          { kind: "source", id: update.source },
          { kind: "skill", id: key },
        ],
      },
      async (wrote) => {
        const session = await this.#options.importer.options.github.session();
        const fetched = await this.#fetchAt(session, update, update.head);
        try {
          await this.#replace(key, fetched, folderOf(entry), trashMine, wrote, (next) => ({
            ...next,
            skillFolderHash: update.folderSha,
          }));
          this.#dropUpdate(key);
        } finally {
          await fetched.dispose();
        }
      },
    );
  }

  /**
   * Swaps the Skill at `path` in `fetched` into the Library under `key` and
   * rewrites its lock entry from `fetched`. The old folder goes to `trash/`
   * when `trashMine`, else it's removed (it's exactly the version it was Imported at).
   */
  async #replace(
    key: string,
    fetched: FetchedSource,
    path: string,
    trashMine: boolean,
    wrote: Wrote,
    finish: (entry: LibraryLockEntry) => LibraryLockEntry,
  ) {
    const { library, trash } = this.#options;
    this.#assertLockReadable();
    const candidate = fetched.candidates.find((found) => found.path === path);
    if (!candidate) throw new ImportSkillNotFound(fetched.fullName, path);
    const staged = (await installFetched(fetched, [candidate])).get(path) ?? "";
    const computedHash = await computeSkillFolderHash(staged);
    const folder = library.folder(key);
    if (trashMine) {
      wrote(await trash.keepVersion(key));
    } else {
      const old = join(library.libraryHome, "staging", randomUUID());
      await mkdir(old, { recursive: true });
      await rename(folder, join(old, "old"));
      await rm(old, { recursive: true, force: true });
    }
    await mkdir(join(folder, ".."), { recursive: true });
    await rename(staged, folder);
    wrote(folder);
    wrote(
      await library.lock.update((current) => {
        const previous = current.skills[key];
        if (!previous) throw new SkillNotFound(key);
        const {
          orphaned: _orphaned,
          skippedUpdate: _skipped,
          refType: _refType,
          skillFolderHash: _folderHash,
          ...rest
        } = previous;
        const next: LibraryLockEntry = finish({
          ...rest,
          source: fetched.fullName,
          sourceType: "github",
          ref: fetched.ref,
          commit: fetched.commit,
          skillPath: skillPathOf(path),
          computedHash,
          ...(fetched.refType === "tag" && { refType: "tag" as const }),
        });
        return { ...current, skills: { ...current.skills, [key]: next } };
      }),
    );
  }

  /** Detach: `local/<name>` (or `-<hash7>` when taken), Source dropped, Links and Copies follow the new key. */
  detach(key: string, client: ActivityClient): Promise<DetachResult> {
    return this.#serial(async () => {
      const result = await this.#detach(key, client);
      this.#options.onChange();
      return result;
    });
  }

  async #detach(key: string, client: ActivityClient): Promise<DetachResult> {
    const { library, activity, home, hooks } = this.#options;
    const entry = library.lock.value.skills[key];
    if (!entry) throw new SkillNotFound(key);
    const name = splitKey(key).name;
    const computedHash = await computeSkillFolderHash(library.folder(key));
    const taken = (candidate: string) => candidate in library.lock.value.skills;
    let newKey = `local/${name}`;
    if (taken(newKey)) newKey = `local/${name}-${createHash("sha256").update(key).digest("hex").slice(0, 7)}`;
    const renames = [{ from: key, to: newKey }];
    return activity.track(
      {
        client,
        action: "importer.detach",
        subjects: [
          { kind: "skill", id: key },
          { kind: "skill", id: newKey },
        ],
      },
      async (wrote) => {
        this.#assertLockReadable();
        const rel = (path: string) => homeRelative(home, path);
        const lockPath = rel(library.lock.path);
        const steps: PlanStep[] = [
          { kind: "move", from: rel(library.folder(key)), to: rel(library.folder(newKey)) },
          { kind: "editFile", path: lockPath, change: `detach ${key} → ${newKey}` },
        ];
        for (const hook of hooks) steps.push(...(await hook.steps(renames)));
        await applySteps(steps, {
          home,
          libraryHome: library.libraryHome,
          wrote,
          editFile: async (step) => {
            if (step.path === lockPath) {
              const path = await library.lock.update((current) => {
                const { [key]: _old, ...skills } = current.skills;
                const detached: LibraryLockEntry = {
                  source: rel(library.folder(newKey)),
                  sourceType: "local",
                  computedHash,
                  detachedFrom: { key, source: entry.source, ...(entry.skillPath && { skillPath: entry.skillPath }) },
                  ...(entry.adoptedFrom && { adoptedFrom: entry.adoptedFrom }),
                };
                return { ...current, skills: { ...skills, [newKey]: detached } };
              });
              return path ? [path] : [];
            }
            for (const hook of hooks) {
              const written = await hook.editFile(step, renames);
              if (written) return written;
            }
            throw new Error(`Nothing knows how to edit ${step.path}`);
          },
        });
        await removeEmptyFolders(library.folder(key), join(library.libraryHome, "skills"));
        this.#dropUpdate(key);
        return { key, newKey };
      },
    );
  }

  /**
   * Re-point: follow another repo, path, branch or tag (a tree URL). The
   * Skill keeps its key; the version there replaces yours, which goes to `trash/`.
   */
  repoint({ key, input }: RepointInput, client: ActivityClient): Promise<void> {
    return this.#serial(async () => {
      const { library, activity, importer } = this.#options;
      const entry = library.lock.value.skills[key];
      if (!entry) throw new SkillNotFound(key);
      const source = parseImportSource(input);
      await activity.track(
        {
          client,
          action: "importer.repoint",
          subjects: [
            { kind: "source", id: source.fullName },
            { kind: "skill", id: key },
          ],
        },
        async (wrote) => {
          const session = await importer.options.github.session();
          const fetched = await importer.fetch(session, source);
          try {
            const name = installedName(splitKey(key).name);
            const candidate =
              (fetched.candidates.length === 1 ? fetched.candidates[0] : undefined) ??
              fetched.candidates.find((found) => installedName(found.name) === name);
            if (!candidate) throw new ImportSkillNotFound(fetched.fullName, fetched.subpath ?? name);
            const { folders } = await this.#options.checks.folders(
              session,
              { source: fetched.fullName, ref: fetched.ref },
              fetched.commit,
            );
            const folderSha = folders.get(candidate.path);
            await this.#replace(key, fetched, candidate.path, true, wrote, (next) => ({
              ...next,
              ...(folderSha && { skillFolderHash: folderSha }),
            }));
            this.#dropUpdate(key);
          } finally {
            await fetched.dispose();
          }
        },
      );
      this.#options.onChange();
    });
  }

  /** The daily run's update check (#11 point 6). It only looks: it notifies about new updates and never applies one. */
  job(): DailyJob {
    return {
      name: "importer.checkUpdates",
      run: async ({ client, notifier }) => {
        const before = new Set((await this.view()).updates.map((update) => `${update.key}@${update.folderSha}`));
        const { updates } = await this.check({}, client);
        const fresh = updates.filter((update) => !before.has(`${update.key}@${update.folderSha}`));
        if (fresh.length > 0) {
          notifier.notify({
            title: fresh.length === 1 ? "1 Skill update" : `${fresh.length} Skill updates`,
            body: fresh.map((update) => update.key).join(", "),
            path: "/library/updates",
          });
        }
      },
    };
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }
}
