import type { AdoptPermissionKind, AgentId } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { OnOffSwitch } from "@/components/project-skills";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";

/** `.agents` first: it's the shared, tool-neutral folder (ADR-0007). */
const agents: AgentId[] = ["agents", "claude-code", "cursor", "opencode", "codex"];

/** Agents with an MCP config of their own; `.agents` is a skills folder only. */
const hasMcpConfig = (agent: AgentId) => agent !== "agents";

/** The Agent Config Guard's switch, in the user's words. */
const guardLabel = "Never edit Agent config files";

/**
 * One Agent's Skills or MCP Adopt Permission (ADR-0007), saved straight away.
 * Greyed out for MCP while the Agent Config Guard is on. Settings › Agents and
 * First run's Adopt step share it.
 */
export function AdoptPermissionSwitch({ agent, kind }: { agent: AgentId; kind: AdoptPermissionKind }) {
  const trpc = useTRPC();
  const preferences = useQuery(trpc.settings.get.queryOptions()).data?.preferences;
  const setPermission = useMutation(trpc.settings.setAdoptPermission.mutationOptions());
  if (!preferences) return null;
  return (
    <span className="flex flex-col items-center gap-1">
      <OnOffSwitch
        on={preferences.adoptPermissions[agent][kind]}
        disabled={setPermission.isPending || (kind === "mcp" && preferences.agentConfigGuard)}
        label={`Allow moving ${kind === "skills" ? "Skills" : "MCP Servers"} from ${agentName(agent)}`}
        onChange={(allowed) => setPermission.mutate({ agent, kind, allowed })}
      />
      {setPermission.error && <span className="text-status-warning text-meta">{setPermission.error.message}</span>}
    </span>
  );
}

/**
 * Settings › Agents (#54, ADR-0007): the Agent Config Guard, and each Agent's
 * Adopt Permissions, under their glossary names. Each switch saves straight
 * away; the MCP switches are greyed out while the Guard is on.
 */
export function AgentsSettings() {
  const trpc = useTRPC();
  const preferences = useQuery(trpc.settings.get.queryOptions()).data?.preferences;
  const setGuard = useMutation(trpc.settings.setAgentConfigGuard.mutationOptions());
  if (!preferences) return null;
  const guarded = preferences.agentConfigGuard;

  return (
    <section data-testid="agents-settings" className="flex flex-col gap-3">
      <h2 className="font-semibold text-section">Agents</h2>
      <h3 className="font-medium text-muted-foreground text-meta">Agent Config Guard</h3>
      <div className="flex min-h-16 items-center gap-6 rounded-xl border px-5 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-body">{guardLabel}</span>
          <p className="text-muted-foreground text-meta">
            Dark Matter won't change an Agent's global config: no turning off Agent-managed Skills or MCP Servers, and
            no moving MCP Servers into the Library. What it delivers into Projects isn't affected.
          </p>
        </div>
        <OnOffSwitch
          on={guarded}
          disabled={setGuard.isPending}
          label={guardLabel}
          onChange={(on) => setGuard.mutate({ on })}
        />
      </div>
      {setGuard.error && <p className="text-body text-status-warning">{setGuard.error.message}</p>}
      <h3 className="font-medium text-muted-foreground text-meta">Adopt Permissions</h3>
      <div className="divide-y rounded-xl border">
        <div className="flex items-center gap-6 px-5 py-2 text-muted-foreground text-meta">
          <span className="flex-1">Adopt may move what it finds in each Agent's own folders and config.</span>
          <span className="w-24 text-center">Skills</span>
          <span className="w-24 text-center">MCP Servers</span>
        </div>
        {agents.map((agent) => (
          <div key={agent} data-testid="agent-permission-row" className="flex min-h-12 items-center gap-6 px-5 py-2">
            <span className="flex-1 font-medium text-body">{agentName(agent)}</span>
            <span className="flex w-24 justify-center">
              <AdoptPermissionSwitch agent={agent} kind="skills" />
            </span>
            <span className="flex w-24 justify-center">
              {hasMcpConfig(agent) ? (
                <AdoptPermissionSwitch agent={agent} kind="mcp" />
              ) : (
                <span className="text-muted-foreground text-meta">No MCP config</span>
              )}
            </span>
          </div>
        ))}
        {guarded && (
          <p data-testid="agent-config-guard-reason" className="px-5 py-2 text-muted-foreground text-meta">
            MCP switches are greyed out while the Agent Config Guard is on: no MCP Server can be adopted until it's off.
          </p>
        )}
      </div>
    </section>
  );
}
