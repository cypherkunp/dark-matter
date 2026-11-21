import type { AgentCard } from "@dark-matter/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { PageHead } from "@/components/page-head";
import { StatusDot } from "@/components/status-dot";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/computer/agents")({ component: Agents });

function Card({ agent }: { agent: AgentCard }) {
  const scanned = agent.detected !== null;
  return (
    <div data-testid="agent-card" className="flex flex-col gap-3 rounded-xl border px-5 py-4">
      <div className="flex items-center gap-2">
        <StatusDot tone={agent.detected ? "healthy" : "off"} />
        <h2 className="font-semibold text-sm">{agent.name}</h2>
        <span className="ml-auto text-muted-foreground text-xs">
          {scanned ? (agent.detected ? "Detected" : "Not detected") : "Not scanned yet"}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Global skill folder</dt>
        <dd className="truncate font-mono">{agent.globalSkillFolder}</dd>
        <dt className="text-muted-foreground">Global Skills</dt>
        <dd>
          {agent.globalSkillCount === null ? (
            "–"
          ) : (
            <Link to="/inbox" className="inline-flex items-center gap-0.5 tabular-nums hover:underline">
              {agent.globalSkillCount}
              <ChevronRight className="size-3" />
            </Link>
          )}
        </dd>
        <dt className="text-muted-foreground">Agent-managed Skills</dt>
        <dd data-testid="agent-managed-count">
          {agent.managedSkillCount === null ? (
            "–"
          ) : (
            <Link to="/inbox" className="inline-flex items-center gap-0.5 tabular-nums hover:underline">
              {agent.managedSkillCount}
              <ChevronRight className="size-3" />
            </Link>
          )}
        </dd>
        {agent.managedMcpServerCount !== null && (
          <>
            <dt className="text-muted-foreground">Agent-managed MCP</dt>
            <dd data-testid="agent-managed-mcp-count" title={agent.managedMcpNotes.join("\n")}>
              <Link
                to="/computer/mcp-servers"
                className="inline-flex items-center gap-0.5 tabular-nums hover:underline"
              >
                {agent.managedMcpServerCount}
                <ChevronRight className="size-3" />
              </Link>
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">MCP config</dt>
        <dd data-testid="agent-mcp-config" className="truncate font-mono">
          {agent.mcpConfig ?? "No MCP Servers"}
          {agent.globalMcpServerCount !== null && agent.globalMcpServerCount > 0 && (
            <Link to="/inbox" className="ml-2 inline-flex items-center gap-0.5 font-sans tabular-nums hover:underline">
              {agent.globalMcpServerCount} global
              <ChevronRight className="size-3" />
            </Link>
          )}
        </dd>
      </dl>
    </div>
  );
}

function Agents() {
  const trpc = useTRPC();
  const agents = useQuery(trpc.agents.list.queryOptions());
  const list = agents.data ?? [];
  const detected = list.filter((agent) => agent.detected).length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <PageHead
        title="Agents"
        summary={`${list.length} Agents · ${detected} detected`}
        status="Global skill folders each Agent loads, from the last Scan"
      />
      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {list.map((agent) => (
          <Card key={agent.id} agent={agent} />
        ))}
      </section>
    </div>
  );
}
