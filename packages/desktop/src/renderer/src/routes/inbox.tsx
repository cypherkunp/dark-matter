import type { GlobalSkill, InboxFolderGroup } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Inbox as InboxIcon } from "lucide-react";
import { useState } from "react";
import { AdoptDialog } from "@/components/adopt-dialog";
import { PageHead } from "@/components/page-head";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { useScan } from "@/components/use-scan";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";
import { relativeTime, useNow } from "@/lib/use-now";

export const Route = createFileRoute("/inbox")({ component: Inbox });

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

type Adopt = (findings: string[]) => void;

function Finding({ finding, onAdopt }: { finding: GlobalSkill; onAdopt: Adopt }) {
  const trpc = useTRPC();
  const ignore = useMutation(trpc.inbox.ignore.mutationOptions());
  const reachedFrom = finding.locations.filter((location) => location.path !== finding.realPath);
  return (
    <div data-testid="inbox-finding" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <StatusDot tone="warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{finding.name}</span>
          {finding.localSource && (
            <span className="rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              Local Source
            </span>
          )}
        </div>
        {finding.description && <p className="truncate text-muted-foreground text-xs">{finding.description}</p>}
        <div className="truncate font-mono text-muted-foreground text-xs">
          {[finding.source, finding.realPath, ...reachedFrom.map((location) => `↖ ${location.path}`)]
            .filter(Boolean)
            .join(" · ")}
        </div>
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

function FolderGroup({ group, onAdopt }: { group: InboxFolderGroup; onAdopt: Adopt }) {
  return (
    <section data-testid="inbox-group" className="flex flex-col gap-3">
      <h2 className="flex flex-wrap items-center gap-2 font-semibold text-sm">
        <span className="font-mono">{group.folder}</span>
        <span className="font-normal text-muted-foreground text-xs tabular-nums">{group.findings.length}</span>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {group.agents.map((agent) => (
            <span key={agent} className="rounded-md border px-1.5 py-0.5 font-normal text-[11px] text-muted-foreground">
              {agentName(agent)}
            </span>
          ))}
          {group.findings.length > 1 && (
            <Button
              size="xs"
              variant="ghost"
              className="font-normal"
              onClick={() => onAdopt(group.findings.map((finding) => finding.id))}
            >
              Adopt all {group.findings.length}
            </Button>
          )}
        </span>
      </h2>
      <div className="divide-y rounded-xl border">
        {group.findings.map((finding) => (
          <Finding key={finding.id} finding={finding} onAdopt={onAdopt} />
        ))}
      </div>
    </section>
  );
}

function Inbox() {
  const trpc = useTRPC();
  const inbox = useQuery(trpc.inbox.list.queryOptions());
  const { scan, scanning, lastScanAt } = useScan();
  const now = useNow();
  const groups = inbox.data?.globalSkills ?? [];
  const count = inbox.data?.count ?? 0;
  const ignored = inbox.data?.ignoredCount ?? 0;
  const [adopting, setAdopting] = useState<string[] | null>(null);
  const allFindings = groups.flatMap((group) => group.findings.map((finding) => finding.id));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <PageHead
        title="Inbox"
        summary={`${plural(count, "finding")} waiting · ${plural(groups.length, "Agent folder")}${ignored ? ` · ${ignored} ignored` : ""}`}
        status={lastScanAt ? `Last Scan ${relativeTime(Date.parse(lastScanAt), now)}` : "Not scanned yet"}
      />
      {inbox.isPending ? null : count === 0 ? (
        <section
          data-testid="inbox-empty"
          className="flex flex-col items-center gap-3 rounded-xl border px-6 py-16 text-center"
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <InboxIcon className="size-5 text-muted-foreground" />
          </div>
          <h2 className="font-semibold text-base">{lastScanAt ? "Nothing waiting on you" : "No Scan yet"}</h2>
          <p className="max-w-sm text-muted-foreground text-sm">
            A Scan reads every Agent's global skill folders and lists the Global Skills it finds here. It never changes
            anything.
          </p>
          <Button size="sm" variant="outline" disabled={scanning} onClick={scan}>
            {scanning ? "Scanning…" : "Scan now"}
          </Button>
        </section>
      ) : (
        <>
          <div className="flex items-start gap-4">
            <p className="flex-1 text-muted-foreground text-sm">
              Global Skills load in every Project. Adopt them into the Library so each Project asks for only what it
              needs.
            </p>
            {allFindings.length > 1 && (
              <Button size="sm" onClick={() => setAdopting(allFindings)}>
                Adopt all {allFindings.length}
              </Button>
            )}
          </div>
          {groups.map((group) => (
            <FolderGroup key={group.folder} group={group} onAdopt={setAdopting} />
          ))}
        </>
      )}
      <AdoptDialog findings={adopting} onClose={() => setAdopting(null)} />
    </div>
  );
}
