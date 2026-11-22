import {
  type Adoptability,
  type AdoptPermissionKind,
  type AgentId,
  type NotAdoptableReason,
  Preferences,
  type ScanResult,
} from "@dark-matter/contracts";
import { type AgentPathEnv, agentAdapters } from "./agents";
import { fromHomeRelative } from "./home-path";

/**
 * What a Scan finding is, for Adopt (ADR-0007): a Skill or an MCP Server, found
 * in an Agent's global folder or config, untracked inside a Project, or one the
 * Agent manages itself. Named like the Inventory's kinds.
 */
export type AdoptSubject =
  | "globalSkill"
  | "untrackedSkill"
  | "managedSkill"
  | "globalMcpServer"
  | "untrackedMcpServer"
  | "managedMcpServer";

/** Which of the Owning Agent's two Adopt Permissions decides each subject. */
const permissionFor: Record<AdoptSubject, AdoptPermissionKind> = {
  globalSkill: "skills",
  untrackedSkill: "skills",
  managedSkill: "skills",
  globalMcpServer: "mcp",
  untrackedMcpServer: "mcp",
  managedMcpServer: "mcp",
};

/** The settings that decide Adopt (ADR-0007): the Adopt Permissions and the Agent Config Guard. */
export type AdoptGate = Pick<Preferences, "adoptPermissions" | "agentConfigGuard">;

/** The defaults ADR-0007 sets: everything off but `.agents`, the Guard on. */
export const defaultAdoptGate = (): AdoptGate => Preferences.parse({});

/**
 * Whether Adopt may move one finding, owned by `owningAgent` (ADR-0007):
 * Agent-managed things never move; a Project's `.agents/skills` always may; no
 * MCP Server moves while the Agent Config Guard is on; everything else follows
 * the Owning Agent's Skills or MCP Adopt Permission. Undo Adopt doesn't ask.
 */
export const adoptability = (gate: AdoptGate, subject: AdoptSubject, owningAgent: AgentId): Adoptability => {
  const allowed: Adoptability = { owningAgent, adoptable: true, notAdoptableReason: null };
  const refused = (reason: NotAdoptableReason): Adoptability => ({
    owningAgent,
    adoptable: false,
    notAdoptableReason: reason,
  });
  if (subject === "managedSkill" || subject === "managedMcpServer") return refused("agentManaged");
  if (subject === "untrackedSkill" && owningAgent === "agents") return allowed;
  const permission = permissionFor[subject];
  if (permission === "mcp" && gate.agentConfigGuard) return refused("agentConfigGuard");
  return gate.adoptPermissions[owningAgent][permission] ? allowed : refused("adoptPermissionOff");
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
export const withAdoptability = (scan: ScanResult, gate: AdoptGate): ScanResult => {
  const recomputeAs =
    (subject: AdoptSubject) =>
    <F extends Adoptability>(finding: F): F => ({
      ...finding,
      ...adoptability(gate, subject, finding.owningAgent),
    });
  return {
    ...scan,
    globalSkills: scan.globalSkills.map(recomputeAs("globalSkill")),
    globalMcpServers: scan.globalMcpServers.map(recomputeAs("globalMcpServer")),
    managedSkills: scan.managedSkills.map(recomputeAs("managedSkill")),
    managedMcpServers: scan.managedMcpServers.map(recomputeAs("managedMcpServer")),
    projects: scan.projects.map((project) => ({
      ...project,
      mcpServers: project.mcpServers.map(recomputeAs("untrackedMcpServer")),
    })),
  };
};
