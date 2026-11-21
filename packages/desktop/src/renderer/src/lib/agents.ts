import type { AgentId } from "@dark-matter/contracts";

const agentNames: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  codex: "Codex",
  agents: ".agents",
};

export const agentName = (id: AgentId) => agentNames[id];
