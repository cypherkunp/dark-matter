import type { AgentId, InventoryReadOnlyReason } from "./schemas";

const agentNames: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  codex: "Codex",
  agents: ".agents",
};

/** An Agent's name as the user reads it. */
export const agentName = (id: AgentId) => agentNames[id];

/**
 * Why a finding is read-only, as one sentence (ADR-0007). The app's read-only
 * rows and the core's `NotAdoptable` error say the same thing. `owner` is the
 * Owning Agent: the one whose folder or config the finding is in.
 */
export const readOnlyReasonText = (reason: InventoryReadOnlyReason, owner: AgentId): string => {
  switch (reason) {
    case "adoptPermissionOff":
      return `${agentName(owner)}'s Adopt Permission is off. Turn it on in Settings to move it.`;
    case "agentConfigGuard":
      return "The Agent Config Guard is on, so no MCP Server can be adopted. Turn it off in Settings to move it.";
    case "agentManaged":
      return `${agentName(owner)} installs and controls it, so Dark Matter can't move it.`;
    case "vendored":
      return "Committed in the repo, so it stays as it is.";
  }
};
