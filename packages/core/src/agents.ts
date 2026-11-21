import { join } from "node:path";
import type { AgentId } from "@dark-matter/contracts";
import { claudeDir, codexDir, opencodeDir } from "./agent-dirs";
import { claudeHistory, codexHistory, cursorHistory, opencodeHistory } from "./history";
import {
  type AgentManagedMcp,
  claudeManagedMcp,
  codexManagedMcp,
  cursorManagedMcp,
  opencodeManagedMcp,
} from "./managed-mcp";
import {
  type AgentManagedSkills,
  claudeManaged,
  codexManaged,
  cursorManaged,
  noManaged,
  opencodeManaged,
} from "./managed-skills";
import { type AgentMcp, claudeMcp, codexMcp, cursorMcp, opencodeMcp } from "./mcp-agents";

/** Where an adapter resolves its paths from. Grows as adapters need more (e.g. `CODEX_HOME`). */
export interface AgentPathEnv {
  home: string;
  /** Where system-wide config (`/etc`, `/Library`) is read from; `/` by default. */
  systemRoot?: string;
  /** `CLAUDE_CONFIG_DIR`: Claude Code's config folder instead of `~/.claude` (review #15). */
  claudeConfigDir?: string;
  /** `CODEX_HOME`: Codex's folder instead of `~/.codex`. */
  codexHome?: string;
  /** `XDG_CONFIG_HOME`: OpenCode's config lives in `<it>/opencode` instead of `~/.config/opencode`. */
  xdgConfigHome?: string;
}

/** A folder an Agent loads Skills from, one `<name>/SKILL.md` per entry. */
export interface SkillFolder {
  path: string;
  /**
   * Entry names in this folder that are not Skills the user put there, e.g.
   * Claude Code's `synced/`. Hidden entries (`.trash`, `.system`) are always skipped.
   */
  ignore?: readonly string[];
}

/**
 * Everything Dark Matter knows about one Agent (facts from the Skill discovery
 * research, #2, checked November 2026). Adding an Agent means adding an adapter.
 *
 * Later tickets add sibling sections here rather than new registries.
 */
export interface AgentAdapter {
  id: AgentId;
  name: string;
  /** The Agent's own folder; it exists when the Agent is installed. */
  configDir(env: AgentPathEnv): string;
  skills: {
    /** Global skill folders it loads: its own first, then compatibility folders. */
    globalFolders(env: AgentPathEnv): SkillFolder[];
    /** Project-relative skill folders it loads, e.g. `.agents/skills`. */
    projectFolders: readonly string[];
    /**
     * The one Project folder Project Skills reach it through (#8): `.agents/skills`
     * for every Agent except Claude Code, which only reads `.claude/skills`.
     */
    deliveryFolder: string;
  };
  project: {
    /** Entries in a Project folder that show the Agent is used there, e.g. `.claude`. */
    markers: readonly string[];
  };
  history: {
    /**
     * Absolute folders the Agent's own history shows it worked in, for
     * Suggested Projects. Read-only and defensive: unknown shapes are skipped.
     */
    projectFolders(env: AgentPathEnv): Promise<string[]>;
  };
  /** Agent-managed Skill locations (read-only) and "Turn off everywhere" (managed-skills.ts). */
  managed: AgentManagedSkills;
  /** MCP config locations, format and reading (mcp-agents.ts); null for an Agent with no MCP surface. */
  mcp: AgentMcp | null;
  /** Agent-managed MCP Servers (read-only) and "Turn off everywhere" where documented (managed-mcp.ts); null with no MCP surface. */
  managedMcp: AgentManagedMcp | null;
}

const claudeSkills = (env: AgentPathEnv): SkillFolder => ({
  path: join(claudeDir(env), "skills"),
  // claude.ai account Skills, synced and rewritten by Claude Code (`.trash` is hidden).
  ignore: ["synced"],
});
const agentsSkills = ({ home }: AgentPathEnv): SkillFolder => ({ path: join(home, ".agents/skills") });
const codexSkills = (env: AgentPathEnv): SkillFolder => ({ path: join(codexDir(env), "skills") });
const cursorSkills = ({ home }: AgentPathEnv): SkillFolder => ({ path: join(home, ".cursor/skills") });
const opencodeSkills = (env: AgentPathEnv): SkillFolder => ({ path: join(opencodeDir(env), "skills") });

const claudeCode: AgentAdapter = {
  id: "claude-code",
  name: "Claude Code",
  configDir: claudeDir,
  // Claude Code alone doesn't read `.agents/skills` (anthropics/claude-code#31005).
  skills: {
    globalFolders: (env) => [claudeSkills(env)],
    projectFolders: [".claude/skills"],
    deliveryFolder: ".claude/skills",
  },
  project: { markers: [".claude", "CLAUDE.md"] },
  history: { projectFolders: claudeHistory },
  managed: claudeManaged,
  mcp: claudeMcp,
  managedMcp: claudeManagedMcp,
};

const cursor: AgentAdapter = {
  id: "cursor",
  name: "Cursor",
  configDir: ({ home }) => join(home, ".cursor"),
  // `~/.cursor/skills-cursor/` holds Cursor's built-ins: Agent-managed, not global.
  skills: {
    globalFolders: (env) => [cursorSkills(env), agentsSkills(env), claudeSkills(env), codexSkills(env)],
    projectFolders: [".cursor/skills", ".agents/skills", ".claude/skills", ".codex/skills"],
    deliveryFolder: ".agents/skills",
  },
  project: { markers: [".cursor"] },
  history: { projectFolders: cursorHistory },
  managed: cursorManaged,
  mcp: cursorMcp,
  managedMcp: cursorManagedMcp,
};

const opencode: AgentAdapter = {
  id: "opencode",
  name: "OpenCode",
  configDir: opencodeDir,
  skills: {
    globalFolders: (env) => [opencodeSkills(env), claudeSkills(env), agentsSkills(env)],
    projectFolders: [".opencode/skills", ".claude/skills", ".agents/skills"],
    deliveryFolder: ".agents/skills",
  },
  project: { markers: [".opencode", "opencode.json", "opencode.jsonc"] },
  history: { projectFolders: opencodeHistory },
  managed: opencodeManaged,
  mcp: opencodeMcp,
  managedMcp: opencodeManagedMcp,
};

const codex: AgentAdapter = {
  id: "codex",
  name: "Codex",
  configDir: codexDir,
  // `~/.codex/skills` is deprecated but still loaded; its `.system/` (hidden) is Agent-managed.
  // The admin folder `/etc/codex/skills` is outside `$HOME` and not scanned yet.
  skills: {
    globalFolders: (env) => [agentsSkills(env), codexSkills(env)],
    projectFolders: [".agents/skills"],
    deliveryFolder: ".agents/skills",
  },
  project: { markers: [".codex"] },
  history: { projectFolders: codexHistory },
  managed: codexManaged,
  mcp: codexMcp,
  managedMcp: codexManagedMcp,
};

const agents: AgentAdapter = {
  id: "agents",
  name: ".agents",
  configDir: ({ home }) => join(home, ".agents"),
  skills: {
    globalFolders: (env) => [agentsSkills(env)],
    projectFolders: [".agents/skills"],
    deliveryFolder: ".agents/skills",
  },
  project: { markers: [".agents", "AGENTS.md"] },
  // The convention has no history of its own.
  history: { projectFolders: async () => [] },
  managed: noManaged,
  // There is no `.agents` convention for MCP Servers (#3).
  mcp: null,
  managedMcp: null,
};

/** The v1 Agents, in the order screens list them. */
export const agentAdapters: readonly AgentAdapter[] = [claudeCode, cursor, opencode, codex, agents];
