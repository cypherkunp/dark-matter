import {
  type Adoptability,
  type AdoptPermissions,
  type AgentId,
  type NotAdoptableReason,
  Preferences,
  type ScanResult,
} from "@dark-matter/contracts";
import { type AgentPathEnv, agentAdapters } from "./agents";
import { fromHomeRelative } from "./home-path";

/**
 * What a Scan finding is, for Adopt (ADR-0007): a Skill or an MCP Server, found
 * in an Agent's global folder or config, or inside a Project, or one the Agent
 * manages itself.
 */
export type AdoptSubject =
  | "globalSkill"
  | "projectSkill"
  | "globalMcpServer"
  | "projectMcpServer"
  | "managedSkill"
  | "managedMcpServer";

/** The defaults ADR-0007 sets: everything off but `.agents`, the Guard on. */
export const defaultPreferences = (): Preferences => Preferences.parse({});

type Gate = Pick<Preferences, "adoptPermissions" | "agentConfigGuard">;

/**
 * Whether Adopt may move one finding, owned by `owningAgent` (ADR-0007):
 * Agent-managed things never move; a Project's `.agents/skills` always may;
 * Global MCP Servers need the Agent Config Guard off (Adopt deletes their
 * global entry); everything else follows the Owning Agent's Skills or MCP
 * Adopt Permission. Undo Adopt doesn't ask.
 */
export const adoptability = (preferences: Gate, subject: AdoptSubject, owningAgent: AgentId): Adoptability => {
  const verdict = (reason: NotAdoptableReason | null): Adoptability => ({
    owningAgent,
    adoptable: reason === null,
    notAdoptableReason: reason,
  });
  if (subject === "managedSkill" || subject === "managedMcpServer") return verdict("agentManaged");
  if (subject === "projectSkill" && owningAgent === "agents") return verdict(null);
  if (subject === "globalMcpServer" && preferences.agentConfigGuard) return verdict("agentConfigGuard");
  const kind: keyof AdoptPermissions[AgentId] = subject.endsWith("McpServer") ? "mcp" : "skills";
  return verdict(preferences.adoptPermissions[owningAgent][kind] ? null : "adoptPermissionOff");
};

/**
 * The Owning Agent of a global skill folder (absolute or home-relative): the
 * one Agent that calls it its own, e.g. `~/.claude/skills` → Claude Code.
 */
export const globalFolderOwner = (env: AgentPathEnv, folder: string): AgentId => {
  const path = fromHomeRelative(env.home, folder);
  const owner =
    agentAdapters.find((adapter) => adapter.skills.ownGlobalFolder(env) === path) ??
    agentAdapters.find((adapter) => adapter.skills.globalFolders(env).some((candidate) => candidate.path === path));
  return owner?.id ?? "agents";
};

/** The Owning Agent of a Project-relative skill folder, e.g. `.cursor/skills` → Cursor. */
export const projectFolderOwner = (folder: string): AgentId =>
  agentAdapters.find((adapter) => adapter.skills.ownProjectFolder === folder)?.id ?? "agents";

/** A Scan's findings with `adoptable` worked out again from the current settings. */
export const withAdoptability = (scan: ScanResult, preferences: Gate): ScanResult => {
  const judge =
    (subject: AdoptSubject) =>
    <F extends Adoptability>(finding: F): F => ({
      ...finding,
      ...adoptability(preferences, subject, finding.owningAgent),
    });
  return {
    ...scan,
    globalSkills: scan.globalSkills.map(judge("globalSkill")),
    globalMcpServers: scan.globalMcpServers.map(judge("globalMcpServer")),
    managedSkills: scan.managedSkills.map(judge("managedSkill")),
    managedMcpServers: scan.managedMcpServers.map(judge("managedMcpServer")),
    projects: scan.projects.map((project) => ({
      ...project,
      mcpServers: project.mcpServers.map(judge("projectMcpServer")),
    })),
  };
};
