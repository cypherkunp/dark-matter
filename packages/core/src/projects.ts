import { realpath } from "node:fs/promises";
import { basename, dirname, sep } from "node:path";
import {
  type AgentId,
  PathGone,
  type ProjectDetail,
  ProjectExists,
  ProjectNotFound,
  type ProjectRecord,
  type ProjectsFile,
  type SettingsFile,
  type SuggestedProject,
} from "@dark-matter/contracts";
import type { CoreServices } from "@dark-matter/contracts/router";
import type { ActivityLog, Wrote } from "./activity";
import { namespaceOf } from "./adopt";
import { type AgentAdapter, type AgentPathEnv, agentAdapters } from "./agents";
import type { EventBus } from "./events";
import { exists, isDirectory, within } from "./fs-util";
import type { OwnedFile } from "./owned-file";
import type { ProjectMcpProcedures } from "./project-mcp";
import type { ProjectSkillProcedures } from "./project-skills";
import { scanProject } from "./scanner";
import type { Scans } from "./scans";
import { projectLockSources } from "./skill-lock";

/**
 * A Project's identity (#8): the git toplevel of `folder` (a `.git` folder or
 * worktree file), else `folder` itself, by real path. `$HOME` is never a
 * toplevel, so a dotfiles repo doesn't swallow every folder under it.
 */
export const projectRoot = async (folder: string, home: string): Promise<{ path: string; git: boolean }> => {
  const real = await realpath(folder);
  const realHome = await realpath(home).catch(() => home);
  for (let dir = real; ; dir = dirname(dir)) {
    if (dir === realHome && real !== realHome) break;
    if (await exists(`${dir}${sep}.git`)) return { path: dir, git: true };
    if (dirname(dir) === dir) break;
  }
  return { path: real, git: false };
};

/**
 * Suggested Projects from every Agent's history (#10): each folder that still
 * exists, at its Project root. `$HOME`, `/` and anything under `exclude` (the
 * Library) are never suggested. No crawl: only folders the history names.
 */
export const suggestProjects = async (
  env: AgentPathEnv,
  adapters: readonly AgentAdapter[],
  exclude: readonly string[] = [],
): Promise<SuggestedProject[]> => {
  const found = new Map<string, SuggestedProject>();
  for (const adapter of adapters) {
    const folders = await adapter.history.projectFolders(env).catch(() => [] as string[]);
    for (const folder of new Set(folders)) {
      if (!(await isDirectory(folder))) continue;
      const root = await projectRoot(folder, env.home).catch(() => null);
      if (!root || root.path === env.home || dirname(root.path) === root.path) continue;
      if (exclude.some((excluded) => within(root.path, excluded))) continue;
      const suggestion = found.get(root.path) ?? { ...root, name: basename(root.path), agents: [] };
      if (!suggestion.agents.includes(adapter.id)) suggestion.agents.push(adapter.id);
      found.set(root.path, suggestion);
    }
  }
  const order = adapters.map((adapter) => adapter.id);
  return [...found.values()]
    .map((suggestion) => ({ ...suggestion, agents: order.filter((id) => suggestion.agents.includes(id)) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
};

/** The Project-relative folders written for these Agents (#8): `.agents/skills`, plus `.claude/skills` for Claude Code. */
export const deliveryFolders = (agents: readonly AgentId[], adapters = agentAdapters): string[] =>
  [
    ...new Set(
      adapters.filter((adapter) => agents.includes(adapter.id)).map((adapter) => adapter.skills.deliveryFolder),
    ),
  ].sort();

export interface ProjectServiceOptions {
  env: AgentPathEnv;
  projects: OwnedFile<typeof ProjectsFile>;
  settings: OwnedFile<typeof SettingsFile>;
  activity: ActivityLog;
  scans: Scans;
  bus: EventBus;
  /** Re-delivers a Project's Skills for a changed record and saves it (#27). */
  deliver?: {
    deliver(path: string, next: ProjectRecord, wrote: Wrote): Promise<unknown>;
    /** Removes Dark Matter's own deliveries before a Project is forgotten (review #5). */
    release(path: string, wrote: Wrote): Promise<void>;
  };
}

/** Suggested Projects waiting on a decision: not confirmed, not dismissed. */
export const waitingSuggestions = (
  scanned: readonly SuggestedProject[],
  projects: ProjectsFile,
  settings: SettingsFile,
) => {
  const dismissed = new Set(settings.dismissedSuggestedProjects);
  const open = scanned.filter((suggestion) => !(suggestion.path in projects.projects));
  return {
    suggested: open.filter((suggestion) => !dismissed.has(suggestion.path)),
    dismissedCount: open.filter((suggestion) => dismissed.has(suggestion.path)).length,
  };
};

/** The `project` domain: confirming, choosing Agents for, locating and forgetting Projects. */
export const projectServices = ({
  env,
  projects,
  settings,
  activity,
  scans,
  bus,
  deliver,
}: ProjectServiceOptions): Omit<
  CoreServices["project"],
  keyof ProjectSkillProcedures | keyof ProjectMcpProcedures | "removePlan"
> => {
  const changed = () => bus.publish({ type: "invalidate", domains: ["project", "inbox"] });

  const detectedAgents = async (path: string): Promise<AgentId[]> => {
    const fromHistory = scans.latest?.suggestedProjects.find((suggestion) => suggestion.path === path)?.agents ?? [];
    const detected: AgentId[] = [];
    for (const adapter of agentAdapters) {
      if (fromHistory.includes(adapter.id)) detected.push(adapter.id);
      else
        for (const marker of adapter.project.markers) {
          if (await exists(`${path}${sep}${marker}`)) {
            detected.push(adapter.id);
            break;
          }
        }
    }
    return detected;
  };

  const record = (path: string): ProjectRecord => {
    const found = projects.value.projects[path];
    if (!found) throw new ProjectNotFound(path);
    return found;
  };

  const detail = async (path: string): Promise<ProjectDetail> => {
    const { agents } = record(path);
    const detected = await detectedAgents(path);
    return {
      path,
      name: basename(path),
      exists: await isDirectory(path),
      agents,
      git: await exists(`${path}${sep}.git`),
      agentOptions: agentAdapters.map((adapter) => ({
        id: adapter.id,
        name: adapter.name,
        detected: detected.includes(adapter.id),
        folder: adapter.skills.deliveryFolder,
      })),
      folders: deliveryFolders(agents),
      skills: scans.latest?.projects.find((scanned) => scanned.path === path)?.skills ?? null,
      mcpServers: scans.latest?.projects.find((scanned) => scanned.path === path)?.mcpServers ?? null,
      grant: record(path).grant === true,
    };
  };

  const rootOf = async (folder: string) => {
    if (!(await isDirectory(folder))) throw new PathGone(folder);
    return projectRoot(folder, env.home);
  };

  return {
    suggested: () => waitingSuggestions(scans.latest?.suggestedProjects ?? [], projects.value, settings.value),

    suggestedSkills: () =>
      Promise.all(
        waitingSuggestions(scans.latest?.suggestedProjects ?? [], projects.value, settings.value).suggested.map(
          async ({ path, name }) => {
            const { skills } = await scanProject(path, agentAdapters);
            // The Namespace Adopt would give each one (review #18): its Source in the Project's skills-lock.json.
            const lock = await projectLockSources(path);
            const inside = (real: string) => real === path || real.startsWith(`${path}${sep}`);
            return {
              path,
              name,
              skills: skills
                .map((skill) => ({
                  ...skill,
                  namespace: inside(skill.realPath) ? namespaceOf(lock[basename(skill.path)]) : "local",
                }))
                .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
            };
          },
        ),
      ),

    list: () =>
      Promise.all(
        Object.entries(projects.value.projects)
          .map(([path, { agents }]) => ({ path, name: basename(path), agents }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
          .map(async (project) => ({ ...project, exists: await isDirectory(project.path) })),
      ),

    get: detail,

    add: async ({ path: folder, agents }, client) => {
      const root = await rootOf(folder);
      return activity.track(
        { client, action: "project.add", subjects: [{ kind: "project", id: root.path }] },
        async (wrote) => {
          if (!(root.path in projects.value.projects)) {
            const chosen = agents ?? (await detectedAgents(root.path));
            const record: ProjectRecord = { agents: chosen.length > 0 ? chosen : ["agents"], skills: {} };
            wrote(
              await projects.update((current) => ({
                ...current,
                projects: { ...current.projects, [root.path]: record },
              })),
            );
            changed();
          }
          return detail(root.path);
        },
      );
    },

    dismiss: (path, client) =>
      activity.track(
        { client, action: "project.dismiss", subjects: [{ kind: "project", id: path }] },
        async (wrote) => {
          wrote(
            await settings.update((current) => ({
              ...current,
              dismissedSuggestedProjects: [...new Set([...current.dismissedSuggestedProjects, path])].sort(),
            })),
          );
          changed();
        },
      ),

    setAgents: ({ path, agents }, client) =>
      activity.track(
        { client, action: "project.setAgents", subjects: [{ kind: "project", id: path }] },
        async (wrote) => {
          const current = record(path);
          const chosen = agentAdapters.map((adapter) => adapter.id).filter((id) => agents.includes(id));
          const next = { ...current, agents: chosen };
          if (deliver) await deliver.deliver(path, next, wrote);
          else wrote(await projects.update((file) => ({ ...file, projects: { ...file.projects, [path]: next } })));
          changed();
          return detail(path);
        },
      ),

    locate: async ({ path, newPath }, client) => {
      record(path);
      const root = await rootOf(newPath);
      return activity.track(
        {
          client,
          action: "project.locate",
          subjects: [
            { kind: "project", id: path },
            { kind: "project", id: root.path },
          ],
        },
        async (wrote) => {
          if (root.path !== path) {
            if (root.path in projects.value.projects) throw new ProjectExists(root.path);
            wrote(
              await projects.update((file) => {
                const { [path]: moved, ...rest } = file.projects;
                return { ...file, projects: { ...rest, [root.path]: moved ?? record(path) } };
              }),
            );
            changed();
          }
          return detail(root.path);
        },
      );
    },

    /** The Grant (#44): On/Off and adding or removing a Link go through without asking. */
    setGrant: ({ path, grant }, client) =>
      activity.track(
        { client, action: grant ? "project.grant" : "project.revokeGrant", subjects: [{ kind: "project", id: path }] },
        async (wrote) => {
          record(path);
          wrote(
            await projects.update((current) => {
              const { grant: _, ...kept } = current.projects[path] ?? {};
              return { ...current, projects: { ...current.projects, [path]: grant ? { ...kept, grant: true } : kept } };
            }),
          );
          bus.invalidate("project");
          return detail(path);
        },
      ),

    remove: (path, client) =>
      activity.track({ client, action: "project.remove", subjects: [{ kind: "project", id: path }] }, async (wrote) => {
        record(path);
        await deliver?.release(path, wrote);
        wrote(
          await projects.update((file) => {
            const { [path]: _removed, ...rest } = file.projects;
            return { ...file, projects: rest };
          }),
        );
        changed();
      }),
  };
};
