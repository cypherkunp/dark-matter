import type { AdoptPermissionKind, AgentId } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { OnOffSwitch } from "@/components/project-skills";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";

/** `.agents` first: it's the shared, tool-neutral folder (ADR-0007). */
const agents: AgentId[] = ["agents", "claude-code", "cursor", "opencode", "codex"];

/** Agents with an MCP config of their own; `.agents` is a skills folder only. */
const hasMcpConfig = (agent: AgentId) => agent !== "agents";

const guardName = "Never edit Agent config files";

/**
 * Settings › Agents (#54, ADR-0007): each Agent's Adopt Permissions, and the
 * Agent Config Guard. Each switch saves straight away; the MCP switches are
 * greyed out while the Guard is on.
 */
export function AgentsSettings() {
  const trpc = useTRPC();
  const preferences = useQuery(trpc.settings.get.queryOptions()).data?.preferences;
  const setPermission = useMutation(trpc.settings.setAdoptPermission.mutationOptions());
  const setGuard = useMutation(trpc.settings.setAgentConfigGuard.mutationOptions());
  const busy = setPermission.isPending || setGuard.isPending;
  const error = setPermission.error ?? setGuard.error;
  if (!preferences) return null;
  const guarded = preferences.agentConfigGuard;

  const permissionSwitch = (agent: AgentId, kind: AdoptPermissionKind) => (
    <OnOffSwitch
      on={preferences.adoptPermissions[agent][kind]}
      disabled={busy || (kind === "mcp" && guarded)}
      label={`Allow moving ${kind === "skills" ? "Skills" : "MCP Servers"} from ${agentName(agent)}`}
      onChange={(allowed) => setPermission.mutate({ agent, kind, allowed })}
    />
  );

  return (
    <section data-testid="agents-settings" className="flex flex-col gap-3">
      <h2 className="font-semibold text-sm">Agents</h2>
      <div className="divide-y rounded-xl border">
        <div className="flex min-h-16 items-center gap-6 px-5 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium text-sm">{guardName}</span>
            <p className="text-muted-foreground text-xs">
              Dark Matter won't change an Agent's global config: no turning off Agent-managed Skills or MCP Servers, and
              no moving Global MCP Servers. What it delivers into Projects isn't affected.
            </p>
          </div>
          <OnOffSwitch on={guarded} disabled={busy} label={guardName} onChange={(on) => setGuard.mutate({ on })} />
        </div>
        <div className="flex items-center gap-6 px-5 py-2 text-muted-foreground text-xs">
          <span className="flex-1">Adopt may move what it finds in each Agent's own folders and config.</span>
          <span className="w-24 text-center">Skills</span>
          <span className="w-24 text-center">MCP Servers</span>
        </div>
        {agents.map((agent) => (
          <div key={agent} data-testid="agent-permission-row" className="flex min-h-12 items-center gap-6 px-5 py-2">
            <span className="flex-1 font-medium text-sm">{agentName(agent)}</span>
            <span className="flex w-24 justify-center">{permissionSwitch(agent, "skills")}</span>
            <span className="flex w-24 justify-center">
              {hasMcpConfig(agent) ? (
                permissionSwitch(agent, "mcp")
              ) : (
                <span className="text-muted-foreground text-xs">No MCP config</span>
              )}
            </span>
          </div>
        ))}
        {guarded && (
          <p data-testid="agent-config-guard-reason" className="px-5 py-2 text-muted-foreground text-xs">
            MCP switches are off limits while “{guardName}” is on: adopting a Global MCP Server removes it from the
            Agent's config.
          </p>
        )}
      </div>
      {error && <p className="text-sm text-status-warning">{error.message}</p>}
    </section>
  );
}
