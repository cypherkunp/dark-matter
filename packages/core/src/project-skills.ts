import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type ActivitySubject,
  type ClientKind,
  CopyModifiedInRepo,
  type KeyRename,
  NameConflict,
  NotInLibrary,
  type PlanStep,
  ProjectNotFound,
  type ProjectRecord,
  type ProjectSkill,
  ProjectSkillNotFound,
  type ProjectSkills,
  type ProjectsFile,
  SkillNotFound,
} from "@dark-matter/contracts";
import type { CoreServices } from "@dark-matter/contracts/router";
import type { ActivityLog, Wrote } from "./activity";
import { applyDelivery, type DeliveryOptions, deliveredName, linkMode, planDelivery } from "./delivery";
import type { EventBus } from "./events";
import { homeRelative } from "./home-path";
import type { Library } from "./library";
import type { KeyRenameHook } from "./namespace-rename";
import type { OwnedFile } from "./owned-file";
import { applySteps } from "./plan";
import {
  COPY_FOLDER,
  copyLockEntry,
  lockEntry,
  projectLockPath,
  readProjectLock,
  writeProjectLock,
} from "./project-lock";
import { deliveryFolders } from "./projects";
import { type LockImporter, lockedSkills, repoSkills } from "./repo-skills";
import { diffSkillFiles } from "./skill-diff";
import { computeSkillFolderHash, readSkillFiles } from "./skill-hash";

export interface ProjectSkillOptions {
  home: string;
  libraryHome: string;
  library: Library;
  projects: OwnedFile<typeof ProjectsFile>;
  activity: ActivityLog;
  bus: EventBus;
  /** Imports a `skills-lock.json` entry missing from the Library (#30 sets it); null shows NotInLibrary. */
  importer?: () => LockImporter | null;
}

/** The `project` procedures for Project Skills. */
export type ProjectSkillProcedures = Pick<
  CoreServices["project"],
  | "skills"
  | "forSkill"
  | "addSkills"
  | "setSkillOn"
  | "removeSkill"
  | "resolveConflict"
  | "updateCopy"
  | "copyDiff"
  | "pullCopy"
  | "repoSkills"
  | "fulfilLock"
>;

interface EditResult {
  next: ProjectRecord;
  removed?: string[];
  options?: Omit<DeliveryOptions, "previous">;
}

/** Refuses to replace or delete a Copy edited in the repo unless the change says you were asked (#28). */
const guardEdits = (path: string, current: ProjectSkill, discardEdits: boolean | undefined) => {
  if (current.copyState === "modifiedInRepo" && !discardEdits) throw new CopyModifiedInRepo(path, current.key);
};

/** How many Projects use each Library Skill, and whether it's in a Name Conflict in any of them. */
export interface SkillUsage {
  projects: number;
  nameConflict: boolean;
}

/**
 * Project Skills (#27): adding Library Skills to Projects, On/Off, Remove and
 * Resolve. Every change is "edit the record, plan the whole Project, apply,
 * then save the record", serialised, so the disk and `projects.json` move
 * together. `deliver` is the same step for any record change (e.g. Agents).
 */
export class ProjectSkillService {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ProjectSkillOptions) {}

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #record(path: string): ProjectRecord {
    const found = this.options.projects.value.projects[path];
    if (!found) throw new ProjectNotFound(path);
    return found;
  }

  /** Delivers `next` into the Project and saves it as the Project's record. */
  async deliver(
    path: string,
    next: ProjectRecord,
    wrote: Wrote,
    removed: readonly string[] = [],
    options: Omit<DeliveryOptions, "previous"> = {},
  ) {
    const { home, libraryHome, library, projects } = this.options;
    const previous = projects.value.projects[path] ?? next;
    const plan = await planDelivery(library, path, next, removed, { ...options, previous });
    await applyDelivery(plan, { home, libraryHome, wrote });
    wrote(await projects.update((file) => ({ ...file, projects: { ...file.projects, [path]: next } })));
    return plan.skills;
  }

  #changed() {
    this.options.bus.publish({ type: "invalidate", domains: ["project", "library", "skill"] });
  }

  /** A delivered Copy and its folder in the Project, or `ProjectSkillNotFound`. */
  async #copy(path: string, key: string) {
    const current = (await planDelivery(this.options.library, path, this.#record(path))).skills.find(
      (skill) => skill.key === key,
    );
    if (current?.mode !== "copy" || current.status !== "on") throw new ProjectSkillNotFound(path, key);
    return { current, folder: join(path, COPY_FOLDER, current.name) };
  }

  /**
   * Pull into Library: the Library Skill's folder (its real one, for a Local
   * Source) is moved to `trash/` and replaced by a copy of the Copy's files.
   */
  async #pull(path: string, key: string, wrote: Wrote) {
    const { home, libraryHome, library } = this.options;
    const { folder } = await this.#copy(path, key);
    const target = await realpath(library.folder(key));
    const rel = (abs: string) => homeRelative(home, abs);
    const trash = join(libraryHome, "trash", `${randomUUID()}-${basename(target)}`);
    await applySteps(
      [
        { kind: "move", from: rel(target), to: rel(trash) },
        { kind: "copy", from: rel(folder), to: rel(target) },
      ],
      { home, libraryHome, wrote, editFile: async () => [] },
    );
    const hash = await computeSkillFolderHash(target);
    wrote(
      await library.lock.update((file) => {
        const entry = file.skills[key];
        if (!entry) return file;
        // A Skill with a Source keeps its upstream hash and is marked Modified; a local one just has new content.
        const next = entry.sourceType === "local" ? { ...entry, computedHash: hash } : { ...entry, modified: true };
        return { ...file, skills: { ...file.skills, [key]: next } };
      }),
    );
  }

  #change(
    client: ClientKind,
    action: string,
    subjects: ActivitySubject[],
    run: (wrote: Wrote) => Promise<ProjectSkills[]>,
  ) {
    return this.#serial(() =>
      this.options.activity.track({ client, action, subjects }, async (wrote) => {
        try {
          return await run(wrote);
        } finally {
          this.#changed();
        }
      }),
    );
  }

  /** One Project Skill change: `edit` returns the next record and the keys it dropped. */
  #changeOne(
    client: ClientKind,
    action: string,
    path: string,
    key: string,
    edit: (record: ProjectRecord, current: ProjectSkill, wrote: Wrote) => EditResult | Promise<EditResult>,
  ) {
    return this.#change(
      client,
      action,
      [
        { kind: "project", id: path },
        { kind: "skill", id: key },
      ],
      async (wrote) => {
        const record = this.#record(path);
        const current = (await planDelivery(this.options.library, path, record)).skills.find(
          (skill) => skill.key === key,
        );
        if (!current) throw new ProjectSkillNotFound(path, key);
        const { next, removed, options } = await edit(record, current, wrote);
        return [{ path, skills: await this.deliver(path, next, wrote, removed, options) }];
      },
    ).then(([result]) => result as ProjectSkills);
  }

  async usage(): Promise<Map<string, SkillUsage>> {
    const usage = new Map<string, SkillUsage>();
    for (const [path, record] of Object.entries(this.options.projects.value.projects)) {
      const { skills } = await planDelivery(this.options.library, path, record).catch(() => ({ skills: [] }));
      for (const skill of skills) {
        const current = usage.get(skill.key) ?? { projects: 0, nameConflict: false };
        usage.set(skill.key, {
          projects: current.projects + 1,
          nameConflict: current.nameConflict || skill.status === "nameConflict",
        });
      }
    }
    return usage;
  }

  /**
   * Rename Namespace (#24) for Project Skills: every Link to a renamed Skill is
   * re-created at its new Library folder, each Copy's `skills-lock.json` entry
   * is rewritten for its new Source, and `projects.json` is re-keyed.
   */
  keyRenameHook(): KeyRenameHook {
    const { home, library, projects } = this.options;
    const rel = (path: string) => homeRelative(home, path);
    const using = (renames: KeyRename[]) =>
      Object.entries(projects.value.projects)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, record]) => ({ path, record, renames: renames.filter((rename) => record.skills[rename.from]) }))
        .filter((project) => project.renames.length > 0);
    return {
      steps: async (renames) => {
        const steps: PlanStep[] = [];
        const affected = using(renames);
        for (const { path, record, renames: own } of affected) {
          let copies = 0;
          for (const { from, to } of own) {
            if (record.skills[from]?.mode === "copy") {
              copies += 1;
              continue;
            }
            const name = await deliveredName(library, from);
            const it = { project: path, key: from, name, source: library.folder(from) };
            for (const folder of deliveryFolders(record.agents)) {
              const link = join(path, folder, name);
              if (!(await linkMode.isDelivered(link, it))) continue;
              steps.push(
                { kind: "removeLink", path: rel(link), target: library.folder(from) },
                { kind: "createLink", path: rel(link), target: library.folder(to) },
              );
            }
          }
          if (copies > 0 && (await readProjectLock(path).catch(() => null)))
            steps.push({
              kind: "editFile",
              path: rel(projectLockPath(path)),
              change: `rewrite ${copies} Copies' Source`,
            });
        }
        if (affected.length > 0)
          steps.push({ kind: "editFile", path: rel(projects.path), change: "re-key renamed Project Skills" });
        return steps;
      },
      editFile: async (step, renames) => {
        if (step.path === rel(projects.path)) {
          const rekey = (skills: ProjectRecord["skills"]) =>
            Object.fromEntries(
              Object.entries(skills).map(([key, value]) => [renames.find((r) => r.from === key)?.to ?? key, value]),
            );
          const written = await projects.update((file) => ({
            ...file,
            projects: Object.fromEntries(
              Object.entries(file.projects).map(([path, record]) => [
                path,
                { ...record, skills: rekey(record.skills) },
              ]),
            ),
          }));
          return written ? [written] : [];
        }
        const project = using(renames).find(({ path }) => rel(projectLockPath(path)) === step.path);
        if (!project) return null;
        const lock = await readProjectLock(project.path);
        if (!lock) return [];
        for (const { from, to } of project.renames) {
          if (project.record.skills[from]?.mode !== "copy") continue;
          const name = await deliveredName(library, to);
          const entry = lockEntry(lock, name);
          if (entry) lock.skills[name] = copyLockEntry(to, library.lock.value.skills[to], name, entry.computedHash);
        }
        await writeProjectLock(project.path, lock);
        return [projectLockPath(project.path)];
      },
    };
  }

  services(): ProjectSkillProcedures {
    const { library, projects } = this.options;
    return {
      skills: async (path) => (await planDelivery(library, path, this.#record(path))).skills,

      forSkill: async (key) => {
        const uses = [];
        for (const [path, record] of Object.entries(projects.value.projects).sort(([a], [b]) => a.localeCompare(b))) {
          if (!record.skills[key]) continue;
          const { skills } = await planDelivery(library, path, record);
          const skill = skills.find((found) => found.key === key);
          if (skill) uses.push({ ...skill, path, projectName: basename(path) });
        }
        return uses;
      },

      addSkills: ({ skills }, client) => {
        const paths = [...new Set(skills.map((skill) => skill.path))];
        const subjects: ActivitySubject[] = [
          ...paths.map((id) => ({ kind: "project" as const, id })),
          ...[...new Set(skills.map((skill) => skill.key))].map((id) => ({ kind: "skill" as const, id })),
        ];
        return this.#change(client, "project.addSkills", subjects, async (wrote) => {
          for (const { key } of skills) if (!(key in library.lock.value.skills)) throw new SkillNotFound(key);
          const nexts = paths.map((path) => {
            const record = this.#record(path);
            const added = Object.fromEntries(
              skills
                .filter((skill) => skill.path === path)
                .map((skill) => [
                  skill.key,
                  { mode: skill.mode ?? record.skills[skill.key]?.mode ?? "link", on: true },
                ]),
            );
            return [path, { ...record, skills: { ...record.skills, ...added } }] as const;
          });
          // Plan every Project first, so one that can't take it (a Name Conflict) stops the lot before any write.
          for (const [path, next] of nexts) {
            const plan = await planDelivery(library, path, next, [], { previous: this.#record(path) });
            for (const skill of plan.skills) {
              const before = this.#record(path).skills[skill.key];
              // Switching a Copy edited in the repo to a Link would delete the edits.
              if (before?.mode === "copy" && skill.mode !== "copy") {
                const current = (await planDelivery(library, path, this.#record(path))).skills.find(
                  (found) => found.key === skill.key,
                );
                if (current) guardEdits(path, current, false);
              }
            }
          }
          const results: ProjectSkills[] = [];
          for (const [path, next] of nexts) results.push({ path, skills: await this.deliver(path, next, wrote) });
          return results;
        });
      },

      setSkillOn: ({ path, key, on, discardEdits }, client) =>
        this.#changeOne(client, on ? "project.skillOn" : "project.skillOff", path, key, (record, current) => {
          // The switch is disabled in a Name Conflict: Resolve first.
          if (current.status === "nameConflict") throw new NameConflict([key], current.paths[0] ?? current.name);
          if (!on) guardEdits(path, current, discardEdits);
          return { next: { ...record, skills: { ...record.skills, [key]: { mode: current.mode, on } } } };
        }),

      removeSkill: ({ path, key, discardEdits }, client) =>
        this.#changeOne(client, "project.removeSkill", path, key, (record, current) => {
          guardEdits(path, current, discardEdits);
          const { [key]: _gone, ...rest } = record.skills;
          return { next: { ...record, skills: rest }, removed: [key] };
        }),

      updateCopy: ({ path, key, discardEdits }, client) =>
        this.#changeOne(client, "project.updateCopy", path, key, (record, current) => {
          if (current.mode !== "copy" || current.status !== "on") throw new ProjectSkillNotFound(path, key);
          guardEdits(path, current, discardEdits);
          return { next: record, options: { refresh: [key] } };
        }),

      copyDiff: async ({ path, key }) => {
        const { folder } = await this.#copy(path, key);
        const [ours, theirs] = await Promise.all([readSkillFiles(library.folder(key)), readSkillFiles(folder)]);
        return { patch: diffSkillFiles(ours, theirs, { a: "library", b: "repo" }) };
      },

      pullCopy: ({ path, key }, client) =>
        this.#changeOne(client, "project.pullCopy", path, key, async (record, _current, wrote) => {
          await this.#pull(path, key, wrote);
          // Re-copied from the Library it now matches, so its lock entry records the new hash.
          return { next: record, options: { refresh: [key] } };
        }),

      repoSkills: (path) => repoSkills(library, path, this.#record(path), this.options.importer?.() ?? null),

      fulfilLock: ({ path, names }, client) =>
        this.#change(client, "project.fulfilLock", [{ kind: "project", id: path }], async (wrote) => {
          const record = this.#record(path);
          const importer = this.options.importer?.() ?? null;
          const locked = await lockedSkills(library, path, record, importer);
          const skills = { ...record.skills };
          const claim: string[] = [];
          for (const name of names) {
            const found = locked.find(({ skill }) => skill.name === name);
            if (!found) throw new ProjectSkillNotFound(path, name);
            const { skill, entry } = found;
            // Not in the Library: Import it first (#30), else say so.
            const key = skill.key ?? (importer ? await importer.importEntry(name, entry) : null);
            if (!key) throw new NotInLibrary(name, entry.source);
            skills[key] = { mode: "copy", on: true };
            if (skill.present) claim.push(key);
          }
          const next = { ...record, skills };
          return [{ path, skills: await this.deliver(path, next, wrote, [], { claim }) }];
        }).then(([result]) => result as ProjectSkills),

      resolveConflict: ({ path, key }, client) =>
        this.#changeOne(client, "project.resolveConflict", path, key, (record, current) => {
          const skills = Object.fromEntries(
            Object.entries(record.skills).filter(([other]) => !current.conflictsWith.includes(other)),
          );
          return { next: { ...record, skills }, removed: current.conflictsWith };
        }),
    };
  }
}
