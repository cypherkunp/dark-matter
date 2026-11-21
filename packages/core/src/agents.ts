import { join } from "node:path";
import type { AgentId } from "@dark-matter/contracts";
import {
  type AgentManagedSkills,
  claudeManaged,
  codexManaged,
  cursorManaged,
  noManaged,
  opencodeManaged,
} from "./managed-skills";

/** Where an adapter resolves its paths from. Grows as adapters need more (e.g. `CODEX_HOME`). */
export interface AgentPathEnv {
  home: string;
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
 * Later tickets add sibling sections here rather than new registries:
 * `history` (sources of Suggested Projects), `mcp`
 * (config locations, formats and translation) and Project skill folders.
 */
export interface AgentAdapter {
  id: AgentId;
  name: string;
  /** The Agent's own folder; it exists when the Agent is installed. */
  configDir(env: AgentPathEnv): string;
  skills: {
    /** Global skill folders it loads: its own first, then compatibility folders. */
    globalFolders(env: AgentPathEnv): SkillFolder[];
  };
  /** Agent-managed Skill locations (read-only) and "Turn off everywhere" (managed-skills.ts). */
  managed: AgentManagedSkills;
}

const claudeSkills = ({ home }: AgentPathEnv): SkillFolder => ({
  path: join(home, ".claude/skills"),
  // claude.ai account Skills, synced and rewritten by Claude Code (`.trash` is hidden).
  ignore: ["synced"],
});
const agentsSkills = ({ home }: AgentPathEnv): SkillFolder => ({ path: join(home, ".agents/skills") });
const codexSkills = ({ home }: AgentPathEnv): SkillFolder => ({ path: join(home, ".codex/skills") });
const cursorSkills = ({ home }: AgentPathEnv): SkillFolder => ({ path: join(home, ".cursor/skills") });
const opencodeSkills = ({ home }: AgentPathEnv): SkillFolder => ({ path: join(home, ".config/opencode/skills") });

const claudeCode: AgentAdapter = {
  id: "claude-code",
  name: "Claude Code",
  configDir: ({ home }) => join(home, ".claude"),
  // Claude Code alone doesn't read `.agents/skills` (anthropics/claude-code#31005).
  skills: { globalFolders: (env) => [claudeSkills(env)] },
  managed: claudeManaged,
};

const cursor: AgentAdapter = {
  id: "cursor",
  name: "Cursor",
  configDir: ({ home }) => join(home, ".cursor"),
  // `~/.cursor/skills-cursor/` holds Cursor's built-ins: Agent-managed, not global.
  skills: {
    globalFolders: (env) => [cursorSkills(env), agentsSkills(env), claudeSkills(env), codexSkills(env)],
  },
  managed: cursorManaged,
};

const opencode: AgentAdapter = {
  id: "opencode",
  name: "OpenCode",
  configDir: ({ home }) => join(home, ".config/opencode"),
  skills: { globalFolders: (env) => [opencodeSkills(env), claudeSkills(env), agentsSkills(env)] },
  managed: opencodeManaged,
};

const codex: AgentAdapter = {
  id: "codex",
  name: "Codex",
  configDir: ({ home }) => join(home, ".codex"),
  // `~/.codex/skills` is deprecated but still loaded; its `.system/` (hidden) is Agent-managed.
  // The admin folder `/etc/codex/skills` is outside `$HOME` and not scanned yet.
  skills: { globalFolders: (env) => [agentsSkills(env), codexSkills(env)] },
  managed: codexManaged,
};

const agents: AgentAdapter = {
  id: "agents",
  name: ".agents",
  configDir: ({ home }) => join(home, ".agents"),
  skills: { globalFolders: (env) => [agentsSkills(env)] },
  managed: noManaged,
};

/** The v1 Agents, in the order screens list them. */
export const agentAdapters: readonly AgentAdapter[] = [claudeCode, cursor, opencode, codex, agents];
