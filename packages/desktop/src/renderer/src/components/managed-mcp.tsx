import type { InboxManagedMcpGroup, ManagedMcpServer, McpOffSwitch } from "@dark-matter/contracts";
import { useMutation } from "@tanstack/react-query";
import { ConsentError, guardedOffSwitchText, useAgentConfigGuard } from "@/components/adopt-consent";
import { definitionSummary } from "@/components/inbox-mcp";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";

const offLabel: Record<McpOffSwitch["scope"], string> = {
  server: "Turn off everywhere",
  plugin: "Turn off plugin everywhere",
  connectors: "Turn off all connectors",
};

const kindLabel: Record<ManagedMcpServer["kind"], string> = {
  plugin: "plugin",
  connector: "claude.ai",
  builtin: "built-in",
  marketplace: "marketplace",
  team: "team",
  system: "system config",
  managed: "managed",
};

/** One Agent-managed MCP Server: read-only, with "Turn off everywhere" where its Agent documents a setting. */
export function ManagedMcpRow({ server, inInbox = false }: { server: ManagedMcpServer; inInbox?: boolean }) {
  const trpc = useTRPC();
  const ignore = useMutation(trpc.inbox.ignore.mutationOptions());
  const turnOff = useMutation(trpc.managedMcp.turnOff.mutationOptions());
  const guarded = useAgentConfigGuard();
  const busy = ignore.isPending || turnOff.isPending;
  return (
    <div data-testid="managed-mcp-server" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <StatusDot tone={server.off ? "off" : "on"} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-body">{server.name}</span>
          <span className="rounded-md border px-1.5 py-0.5 font-mono text-micro text-muted-foreground">
            {server.plugin ?? kindLabel[server.kind]}
          </span>
          {server.off && <span className="text-muted-foreground text-meta">Off</span>}
        </div>
        {(server.definition || server.source) && (
          <div className="truncate font-mono text-muted-foreground text-meta">
            {server.definition ? definitionSummary(server.definition) : server.source}
          </div>
        )}
        {server.readOnly && <p className="text-muted-foreground text-meta">{server.readOnly}</p>}
        {guarded && !server.off && server.offSwitches.length > 0 && (
          <p data-testid="guarded-reason" className="text-muted-foreground text-meta">
            {guardedOffSwitchText}
          </p>
        )}
        <ConsentError error={turnOff.error} className="text-status-warning text-meta" />
      </div>
      {!server.off &&
        server.offSwitches.map((offSwitch) => (
          <Button
            key={offSwitch.scope}
            size="sm"
            variant="outline"
            disabled={busy || guarded}
            title={`Writes ${offSwitch.setting} in ${offSwitch.file}`}
            onClick={() => turnOff.mutate({ id: server.id, scope: offSwitch.scope })}
          >
            {offLabel[offSwitch.scope]}
          </Button>
        ))}
      {inInbox && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => ignore.mutate({ id: server.id })}>
          Ignore
        </Button>
      )}
    </div>
  );
}

/** Agent-managed MCP Servers grouped by Agent. */
export function ManagedMcpGroups({ groups, inInbox = false }: { groups: InboxManagedMcpGroup[]; inInbox?: boolean }) {
  if (groups.length === 0) return null;
  return (
    <>
      <div className="flex flex-col gap-1 pt-2">
        <h2 className="font-semibold text-heading">Agent-managed MCP Servers</h2>
        <p className="text-muted-foreground text-body">
          Plugins, connectors, built-ins and admin layers each Agent adds itself. Dark Matter only lists them, and turns
          them off through the Agent's own settings where it documents one.
        </p>
      </div>
      {groups.map((group) => (
        <section key={group.agent} data-testid="managed-mcp-group" className="flex flex-col gap-3">
          <h3 className="flex items-center gap-2 font-semibold text-body">
            <span>{agentName(group.agent)}</span>
            <span className="font-normal text-muted-foreground text-meta tabular-nums">{group.findings.length}</span>
          </h3>
          <div className="divide-y rounded-xl border">
            {group.findings.map((server) => (
              <ManagedMcpRow key={server.id} server={server} inInbox={inInbox} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** Groups a flat list by Agent, in the order given. */
export const byAgent = (servers: ManagedMcpServer[]): InboxManagedMcpGroup[] => {
  const groups = new Map<string, InboxManagedMcpGroup>();
  for (const server of servers) {
    const group = groups.get(server.agent) ?? { agent: server.agent, findings: [] };
    group.findings.push(server);
    groups.set(server.agent, group);
  }
  return [...groups.values()];
};
