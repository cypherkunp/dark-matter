import { join } from "node:path";
import type { AgentPathEnv } from "./agents";

/**
 * Where each Agent keeps its own files, honouring the environment overrides the
 * Agents document (review #15): `CLAUDE_CONFIG_DIR` for Claude Code (which then
 * keeps `.claude.json` inside it), `CODEX_HOME` for Codex, and
 * `XDG_CONFIG_HOME` for OpenCode.
 */
export const claudeDir = (env: AgentPathEnv) => env.claudeConfigDir ?? join(env.home, ".claude");

/** Claude Code's state file: `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`. */
export const claudeJsonFile = (env: AgentPathEnv) =>
  env.claudeConfigDir ? join(env.claudeConfigDir, ".claude.json") : join(env.home, ".claude.json");

export const codexDir = (env: AgentPathEnv) => env.codexHome ?? join(env.home, ".codex");

export const opencodeDir = (env: AgentPathEnv) => join(env.xdgConfigHome ?? join(env.home, ".config"), "opencode");
