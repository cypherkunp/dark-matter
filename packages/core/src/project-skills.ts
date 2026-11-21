import { basename } from "node:path";
import {
  type ActivitySubject,
  type ClientKind,
  NameConflict,
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
import { applyDelivery, planDelivery } from "./delivery";
import type { EventBus } from "./events";
import type { Library } from "./library";
import type { OwnedFile } from "./owned-file";

export interface ProjectSkillOptions {
  home: string;
  libraryHome: string;
  library: Library;
  projects: OwnedFile<typeof ProjectsFile>;
  activity: ActivityLog;
  bus: EventBus;
}

/** The `project` procedures for Project Skills. */
export type ProjectSkillProcedures = Pick<
  CoreServices["project"],
  "skills" | "forSkill" | "addSkills" | "setSkillOn" | "removeSkill" | "resolveConflict"
>;

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
  async deliver(path: string, next: ProjectRecord, wrote: Wrote, removed: readonly string[] = []) {
    const { home, libraryHome, library, projects } = this.options;
    const plan = await planDelivery(library, path, next, removed);
    await applyDelivery(plan, { home, libraryHome, wrote });
    wrote(await projects.update((file) => ({ ...file, projects: { ...file.projects, [path]: next } })));
    return plan.skills;
  }

  #changed() {
    this.options.bus.publish({ type: "invalidate", domains: ["project", "library"] });
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
    edit: (record: ProjectRecord, current: ProjectSkill) => { next: ProjectRecord; removed?: string[] },
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
        const { next, removed } = edit(record, current);
        return [{ path, skills: await this.deliver(path, next, wrote, removed) }];
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
          for (const [path, next] of nexts) await planDelivery(library, path, next);
          const results: ProjectSkills[] = [];
          for (const [path, next] of nexts) results.push({ path, skills: await this.deliver(path, next, wrote) });
          return results;
        });
      },

      setSkillOn: ({ path, key, on }, client) =>
        this.#changeOne(client, on ? "project.skillOn" : "project.skillOff", path, key, (record, current) => {
          // The switch is disabled in a Name Conflict: Resolve first.
          if (current.status === "nameConflict") throw new NameConflict([key], current.paths[0] ?? current.name);
          return { next: { ...record, skills: { ...record.skills, [key]: { mode: current.mode, on } } } };
        }),

      removeSkill: ({ path, key }, client) =>
        this.#changeOne(client, "project.removeSkill", path, key, (record) => {
          const { [key]: _gone, ...rest } = record.skills;
          return { next: { ...record, skills: rest }, removed: [key] };
        }),

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
