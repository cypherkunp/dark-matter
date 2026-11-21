import type { Inbox } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";

interface Row {
  id: string;
  name: string;
  kind: string;
  where: string;
}

/** Every ignored finding as one row: what it is and where it was found. */
const rows = (inbox: Inbox): Row[] => [
  ...inbox.drift.flatMap((group) =>
    group.findings.map((finding) => ({
      id: finding.id,
      name: finding.name ?? group.name,
      kind: "Drift",
      where: group.name,
    })),
  ),
  ...inbox.globalSkills.flatMap((group) =>
    group.findings.map((finding) => ({
      id: finding.id,
      name: finding.name,
      kind: "Global Skill",
      where: group.folder,
    })),
  ),
  ...inbox.untrackedSkills.flatMap((group) =>
    group.findings.map((finding) => ({
      id: finding.id,
      name: finding.name,
      kind: "Untracked Project Skill",
      where: group.name,
    })),
  ),
  ...inbox.managedSkills.flatMap((group) =>
    group.findings.map((finding) => ({
      id: finding.id,
      name: finding.name,
      kind: "Agent-managed Skill",
      where: agentName(group.agent),
    })),
  ),
  ...inbox.mcpServers.flatMap((group) =>
    group.findings.map((finding) => ({
      id: finding.id,
      name: finding.name,
      kind: "Global MCP Server",
      where: group.file,
    })),
  ),
  ...inbox.managedMcpServers.flatMap((group) =>
    group.findings.map((finding) => ({
      id: finding.id,
      name: finding.name,
      kind: "Agent-managed MCP Server",
      where: agentName(group.agent),
    })),
  ),
  ...inbox.untrackedMcpServers.flatMap((group) =>
    group.findings.map((finding) => ({
      id: finding.id,
      name: finding.name,
      kind: "Untracked Project MCP Server",
      where: group.name,
    })),
  ),
  ...inbox.newSkills.flatMap((group) =>
    group.findings.map((finding) => ({
      id: finding.id,
      name: finding.name,
      kind: "New Skill in a starred Source",
      where: group.source,
    })),
  ),
];

/** "N ignored · Show": the findings you Ignored, each with Restore to put it back in the Inbox. */
export function IgnoredFindings({ count }: { count: number }) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const ignored = useQuery({ ...trpc.inbox.ignored.queryOptions(), enabled: open });
  const restore = useMutation(trpc.inbox.unignore.mutationOptions());
  if (count === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold text-sm">Ignored</h2>
        <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show ignored"}
        </Button>
      </div>
      {open && ignored.data && (
        <div className="flex flex-col divide-y rounded-xl border">
          {rows(ignored.data).map((row) => (
            <div key={row.id} data-testid="ignored-finding" className="flex min-h-16 items-center gap-3 px-5 py-3">
              <StatusDot tone="off" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-sm">{row.name}</span>
                <span className="truncate font-mono text-muted-foreground text-xs">
                  {row.kind} · {row.where}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={restore.isPending}
                onClick={() => restore.mutate({ id: row.id })}
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
