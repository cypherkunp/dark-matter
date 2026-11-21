import type { LibraryMcpServer } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, Server } from "lucide-react";
import { definitionSummary } from "@/components/inbox-mcp";
import { byAgent, ManagedMcpGroups } from "@/components/managed-mcp";
import { PageHead } from "@/components/page-head";
import { Button } from "@/components/ui/button";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/computer/mcp-servers")({ component: McpServers });

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function ServerRow({ server }: { server: LibraryMcpServer }) {
  const trpc = useTRPC();
  const undo = useMutation(trpc.mcp.undoAdopt.mutationOptions());
  const origins = server.adoptedFrom.map((origin) => `${agentName(origin.agent)} ${origin.file}`).join(", ");
  return (
    <div data-testid="library-mcp-server" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{server.name}</span>
          {server.definition && (
            <span className="rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {server.definition.transport}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-muted-foreground text-xs">
          {server.definition ? definitionSummary(server.definition) : server.file}
        </div>
        {server.secrets.length > 0 && (
          <div className="flex items-center gap-1 text-muted-foreground text-xs">
            <KeyRound className="size-3" />
            <span className="truncate font-mono">{server.secrets.join(", ")}</span>
          </div>
        )}
        {server.problem && <p className="text-status-warning text-xs">{server.problem}</p>}
        {undo.error && <p className="text-status-warning text-xs">{undo.error.message}</p>}
      </div>
      {server.adoptedFrom.length > 0 && (
        <Button
          size="sm"
          variant="ghost"
          title={`Put it back into ${origins}`}
          disabled={undo.isPending}
          onClick={() => undo.mutate({ name: server.name })}
        >
          Undo Adopt
        </Button>
      )}
    </div>
  );
}

/** Library MCP Servers: Agent-neutral definitions under `~/.dark-matter/mcp/`. */
function McpServers() {
  const trpc = useTRPC();
  const list = useQuery(trpc.mcp.list.queryOptions());
  const managed = useQuery(trpc.agents.managedMcp.queryOptions());
  const servers = list.data?.servers ?? [];
  const secrets = new Set(servers.flatMap((server) => server.secrets)).size;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <PageHead
        title="MCP Servers"
        summary={`${plural(servers.length, "MCP Server")} · ${plural(secrets, "Secret")}`}
        status="Library definitions in ~/.dark-matter/mcp, Secrets in the keychain"
      />
      {list.isPending ? null : servers.length === 0 ? (
        <section
          data-testid="mcp-empty"
          className="flex flex-col items-center gap-3 rounded-xl border px-6 py-16 text-center"
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <Server className="size-5 text-muted-foreground" />
          </div>
          <h2 className="font-semibold text-base">No MCP Servers in the Library</h2>
          <p className="max-w-sm text-muted-foreground text-sm">
            A Scan lists the MCP Servers in each Agent's global config in the Inbox. Adopt them to define each one once
            here.
          </p>
        </section>
      ) : (
        <div className="divide-y rounded-xl border">
          {servers.map((server) => (
            <ServerRow key={server.name} server={server} />
          ))}
        </div>
      )}
      <ManagedMcpGroups groups={byAgent(managed.data ?? [])} />
    </div>
  );
}
