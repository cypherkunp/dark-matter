import { dirname } from "node:path";
import {
  type AgentId,
  type Inventory,
  type InventoryGroup,
  InventoryItem,
  type McpDefinition,
  type ProjectSkillEntry,
  type ScanResult,
  type UntrackedSkill,
  type VendoredSkill,
} from "@dark-matter/contracts";
import { globalFolderOwner, projectFolderOwner } from "./adopt-permissions";
import { type AgentPathEnv, agentAdapters } from "./agents";
import { homeRelative } from "./home-path";

const agentOrder = (id: AgentId) => agentAdapters.findIndex((adapter) => adapter.id === id);
const byAgentOrder = (ids: Iterable<AgentId>): AgentId[] =>
  [...new Set(ids)].sort((a, b) => agentOrder(a) - agentOrder(b));

/** `.agents` first, then global before Project before Agent-managed, then by Owning Agent and label. */
const scopeOrder: Record<InventoryGroup["scope"], number> = { global: 0, project: 1, managed: 2 };
const compareGroups = (a: InventoryGroup, b: InventoryGroup) =>
  Number(a.owningAgent !== "agents") - Number(b.owningAgent !== "agents") ||
  scopeOrder[a.scope] - scopeOrder[b.scope] ||
  agentOrder(a.owningAgent) - agentOrder(b.owningAgent) ||
  a.label.localeCompare(b.label);

const kindOrder = InventoryItem.shape.kind.options;
const compareItems = (a: InventoryItem, b: InventoryItem) =>
  kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** How an MCP Server runs, as one line: its command and arguments, or its URL. */
const runs = (definition: McpDefinition) =>
  definition.url ?? [definition.command, ...(definition.args ?? [])].filter(Boolean).join(" ");

/** The Skills a Scan found in one Project (confirmed or Suggested) that Dark Matter didn't deliver. */
export interface InventoryProject {
  /** Absolute. */
  path: string;
  name: string;
  untracked: readonly UntrackedSkill[];
  /** Committed ones; `paths` are Project-relative entries. */
  vendored: readonly VendoredSkill[];
}

/** A Suggested Project's committed entries as Vendored Skills: one per real folder, the folder holding it first. */
export const vendoredFrom = (project: string, entries: readonly ProjectSkillEntry[]): VendoredSkill[] => {
  const byReal = new Map<string, ProjectSkillEntry[]>();
  for (const entry of entries) byReal.set(entry.realPath, [...(byReal.get(entry.realPath) ?? []), entry]);
  return [...byReal.values()].flatMap((group) => {
    const ordered = [...group].sort((a, b) => Number(a.symlink) - Number(b.symlink) || a.path.localeCompare(b.path));
    const [first] = ordered;
    if (!first || !group.some((entry) => entry.tracked)) return [];
    const inside = (path: string) => (path.startsWith(`${project}/`) ? path.slice(project.length + 1) : path);
    return [{ name: first.name, description: first.description, paths: ordered.map((entry) => inside(entry.path)) }];
  });
};

/**
 * The Inventory (#55) from the latest Scan: every finding, grouped by the
 * folder or config that owns it, with the Agents that see each one and why
 * it's read-only.
 */
export const inventoryFrom = (
  scan: ScanResult | null,
  env: AgentPathEnv,
  projects: readonly InventoryProject[] = [],
): Inventory => {
  const groups = new Map<string, InventoryGroup>();
  const into = (group: Omit<InventoryGroup, "items">, item: InventoryItem) => {
    const existing = groups.get(group.id) ?? { ...group, items: [] };
    existing.items.push(item);
    groups.set(group.id, existing);
  };
  /** The Agents that load a home-relative global skill folder. */
  const readersOf = (folder: string) =>
    byAgentOrder(
      agentAdapters
        .filter((adapter) =>
          adapter.skills.globalFolders(env).some((candidate) => homeRelative(env.home, candidate.path) === folder),
        )
        .map((adapter) => adapter.id),
    );

  for (const finding of scan?.globalSkills ?? [])
    into(
      {
        id: `global:${finding.folder}`,
        label: finding.folder,
        scope: "global",
        owningAgent: globalFolderOwner(env, finding.folder),
        project: null,
        agents: readersOf(finding.folder),
      },
      {
        id: finding.id,
        kind: "globalSkill",
        name: finding.name,
        detail: finding.description,
        agents: byAgentOrder(finding.agents),
        adoptable: finding.adoptable,
        readOnlyReason: finding.notAdoptableReason,
        off: false,
      },
    );

  /** A Project's skill folder (Project-relative), and the Agents that load it. */
  const projectFolder = (project: InventoryProject, folder: string) => ({
    id: `project:${project.path}:${folder}`,
    label: `${project.name}/${folder}`,
    scope: "project" as const,
    owningAgent: projectFolderOwner(folder),
    project: project.path,
    agents: byAgentOrder(
      agentAdapters.filter((adapter) => adapter.skills.projectFolders.includes(folder)).map((adapter) => adapter.id),
    ),
  });
  const projectReaders = (folders: readonly string[]) =>
    byAgentOrder(
      agentAdapters
        .filter((adapter) => folders.some((folder) => adapter.skills.projectFolders.includes(folder)))
        .map((adapter) => adapter.id),
    );
  for (const project of projects) {
    for (const finding of project.untracked) {
      const folders = finding.locations.map((location) => location.folder);
      into(projectFolder(project, folders[0] ?? ""), {
        id: finding.id,
        kind: "untrackedSkill",
        name: finding.name,
        detail: finding.description,
        agents: projectReaders(folders),
        adoptable: finding.adoptable,
        readOnlyReason: finding.notAdoptableReason,
        off: false,
      });
    }
    for (const skill of project.vendored) {
      const folders = skill.paths.map((path) => dirname(path));
      const [first] = skill.paths;
      into(projectFolder(project, folders[0] ?? ""), {
        id: `vendored-skill:${project.path}/${first ?? skill.name}`,
        kind: "vendoredSkill",
        name: skill.name,
        detail: skill.description,
        agents: projectReaders(folders),
        adoptable: false,
        readOnlyReason: "vendored",
        off: false,
      });
    }
  }

  for (const finding of scan?.globalMcpServers ?? [])
    into(
      {
        id: `global:${finding.file}`,
        label: finding.file,
        scope: "global",
        owningAgent: finding.owningAgent,
        project: null,
        agents: [finding.agent],
      },
      {
        id: finding.id,
        kind: "globalMcpServer",
        name: finding.name,
        detail: runs(finding.definition),
        agents: [finding.agent],
        adoptable: finding.adoptable,
        readOnlyReason: finding.notAdoptableReason,
        off: false,
      },
    );

  /** What each Agent installs and controls itself, under that Agent's own folder. */
  const managed = (agent: AgentId) => {
    const adapter = agentAdapters.find((candidate) => candidate.id === agent);
    return {
      id: `managed:${agent}`,
      label: adapter ? homeRelative(env.home, adapter.configDir(env)) : agent,
      scope: "managed" as const,
      owningAgent: agent,
      project: null,
      agents: [agent],
    };
  };
  for (const finding of scan?.managedSkills ?? [])
    into(managed(finding.agent), {
      id: finding.id,
      kind: "managedSkill",
      name: finding.name,
      detail: finding.description,
      agents: [finding.agent],
      adoptable: finding.adoptable,
      readOnlyReason: finding.notAdoptableReason,
      off: finding.off,
    });
  for (const finding of scan?.managedMcpServers ?? [])
    into(managed(finding.agent), {
      id: finding.id,
      kind: "managedMcpServer",
      name: finding.name,
      detail: finding.definition ? runs(finding.definition) : (finding.plugin ?? finding.kind),
      agents: [finding.agent],
      adoptable: finding.adoptable,
      readOnlyReason: finding.notAdoptableReason,
      off: finding.off,
    });

  const sorted = [...groups.values()].sort(compareGroups);
  for (const group of sorted) group.items.sort(compareItems);
  return { groups: sorted };
};
