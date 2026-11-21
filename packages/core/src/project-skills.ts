import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type ActivitySubject,
  type AgentId,
  type ClientKind,
  NameConflict,
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
import type { KeepLink, KeepLinks } from "./adopt";
import { type AgentAdapter, agentAdapters } from "./agents";
import { applyDelivery, linkMode, planDelivery } from "./delivery";
import type { EventBus } from "./events";
import { homeRelative } from "./home-path";
import type { Library } from "./library";
import type { OwnedFile } from "./owned-file";
import { deliveryFolders } from "./projects";

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

  /**
   * Adopt & keep Link (#29): each Adopted untracked Skill goes back into its
   * Project as an ordinary Project Skill (Link, On). If it was found in a
   * folder the Project's Agents don't get deliveries in, the Agent that uses
   * that folder is added, so the Skill stays where the Agents saw it.
   */
  keepLinks(): KeepLinks {
    const { home, library, projects } = this.options;
    const rel = (path: string) => homeRelative(home, path);
    const byProject = (links: readonly KeepLink[]) => {
      const grouped = new Map<string, KeepLink[]>();
      for (const link of links) grouped.set(link.project, [...(grouped.get(link.project) ?? []), link]);
      return grouped;
    };
    const next = (path: string, links: readonly KeepLink[]) => {
      const record = this.#record(path);
      const { agents, added } = withAgentsFor(
        record.agents,
        links.flatMap((link) => link.folders),
      );
      const skills = { ...record.skills };
      for (const link of links) skills[link.key] = { mode: "link" as const, on: true };
      return { record: { ...record, agents, skills }, added };
    };
    return {
      plan: async (links) => {
        const steps: PlanStep[] = [];
        const warnings: string[] = [];
        for (const [path, own] of byProject(links)) {
          const { record, added } = next(path, own);
          for (const adapter of added) {
            warnings.push(
              `Adds ${adapter.name} to ${basename(path)}'s Agents, so ${adapter.skills.deliveryFolder} keeps its Skills.`,
            );
          }
          for (const link of own) {
            const target = { project: path, key: link.key, name: link.name, source: library.folder(link.key) };
            for (const folder of deliveryFolders(record.agents)) {
              const at = join(path, folder, link.name);
              const taken = await lstat(at).then(
                () => true,
                () => false,
              );
              if (taken && !link.freed.includes(at)) {
                if (await linkMode.isDelivered(at, target)) continue;
                throw new NameConflict([link.key], join(folder, link.name));
              }
              steps.push({ kind: "createLink", path: rel(at), target: rel(target.source) });
            }
          }
        }
        if (steps.length > 0 || links.length > 0) {
          steps.push({
            kind: "editFile",
            path: rel(projects.path),
            change: `add ${[...new Set(links.map((link) => link.key))].sort().join(", ")} as Links, On`,
          });
        }
        return { steps, warnings };
      },
      apply: async (links, wrote) => {
        try {
          for (const [path, own] of byProject(links)) await this.deliver(path, next(path, own).record, wrote);
        } finally {
          this.#changed();
        }
      },
      release: async (path, key, wrote) => {
        const record = projects.value.projects[path];
        if (!record?.skills[key]) return;
        const { [key]: _gone, ...skills } = record.skills;
        try {
          await this.deliver(path, { ...record, skills }, wrote, [key]);
        } finally {
          this.#changed();
        }
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

/**
 * `agents` plus, for each skill folder a Skill was found in, an Agent that
 * gets deliveries there when none does yet: the folder's own Agent (Claude
 * Code for `.claude/skills`), else `.agents/skills`, which every Agent that
 * reads other folders also reads.
 */
const withAgentsFor = (agents: readonly AgentId[], folders: readonly string[]) => {
  const next = [...agents];
  const added: AgentAdapter[] = [];
  for (const folder of folders) {
    const needed = agentAdapters.some((adapter) => adapter.skills.deliveryFolder === folder)
      ? folder
      : ".agents/skills";
    if (deliveryFolders(next).includes(needed)) continue;
    // The Agent that reads only that folder (Claude Code, or the generic `.agents`).
    const adapter = agentAdapters
      .filter(
        (candidate) => candidate.skills.projectFolders.length === 1 && candidate.skills.projectFolders[0] === needed,
      )
      .at(-1);
    if (!adapter) continue;
    next.push(adapter.id);
    added.push(adapter);
  }
  const order = agentAdapters.map((adapter) => adapter.id);
  return { agents: order.filter((id) => next.includes(id)), added };
};
