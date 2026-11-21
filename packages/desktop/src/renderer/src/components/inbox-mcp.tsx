import type { GlobalMcpServer, InboxMcpGroup, McpDefinition } from "@dark-matter/contracts";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { McpAdoptDialog } from "@/components/mcp-adopt-dialog";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";

/** A definition in one line: the command it runs or the URL it calls. */
export const definitionSummary = (definition: McpDefinition) =>
  definition.transport === "stdio"
    ? [definition.command, ...(definition.args ?? [])].join(" ")
    : `${definition.transport} ${definition.url ?? ""}`;

function Finding({ finding, onAdopt }: { finding: GlobalMcpServer; onAdopt: (ids: string[]) => void }) {
  const trpc = useTRPC();
  const ignore = useMutation(trpc.inbox.ignore.mutationOptions());
  return (
    <div data-testid="inbox-mcp-finding" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <StatusDot tone="warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{finding.name}</span>
          {finding.inlineSecrets.length > 0 && (
            <span className="rounded-md border border-warning-border bg-warning-surface px-1.5 py-0.5 text-[11px] text-status-warning">
              {finding.inlineSecrets.length} inline secret{finding.inlineSecrets.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-muted-foreground text-xs">{definitionSummary(finding.definition)}</div>
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" variant="ghost" disabled={ignore.isPending} onClick={() => ignore.mutate({ id: finding.id })}>
          Ignore
        </Button>
        <Button size="sm" variant="outline" onClick={() => onAdopt([finding.id])}>
          Adopt
        </Button>
      </div>
    </div>
  );
}

/** The Inbox's Global MCP Servers, one group per Agent config file, with Adopt. */
export function InboxMcpServers({ groups }: { groups: InboxMcpGroup[] }) {
  const [adopting, setAdopting] = useState<string[] | null>(null);
  if (groups.length === 0) return null;
  return (
    <>
      <div className="flex flex-col gap-1 pt-2">
        <h2 className="font-semibold text-base">Global MCP Servers</h2>
        <p className="text-muted-foreground text-sm">
          These load their tools into every Project. Adopt them into the Library so each Project asks for only what it
          needs; inline secrets move into the keychain.
        </p>
      </div>
      {groups.map((group) => (
        <section key={group.file} data-testid="inbox-mcp-group" className="flex flex-col gap-3">
          <h2 className="flex flex-wrap items-center gap-2 font-semibold text-sm">
            <span className="font-mono">{group.file}</span>
            <span className="font-normal text-muted-foreground text-xs tabular-nums">{group.findings.length}</span>
            <span className="ml-auto flex items-center gap-1">
              <span className="rounded-md border px-1.5 py-0.5 font-normal text-[11px] text-muted-foreground">
                {agentName(group.agent)}
              </span>
              {group.findings.length > 1 && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="font-normal"
                  onClick={() => setAdopting(group.findings.map((finding) => finding.id))}
                >
                  Adopt all {group.findings.length}
                </Button>
              )}
            </span>
          </h2>
          <div className="divide-y rounded-xl border">
            {group.findings.map((finding) => (
              <Finding key={finding.id} finding={finding} onAdopt={setAdopting} />
            ))}
          </div>
        </section>
      ))}
      <McpAdoptDialog findings={adopting} onClose={() => setAdopting(null)} />
    </>
  );
}
