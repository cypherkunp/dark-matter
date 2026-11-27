import type {
  GlobalMcpServer,
  InboxMcpGroup,
  InboxProjectMcpGroup,
  McpDefinition,
  ProjectMcpEntry,
} from "@dark-matter/contracts";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { adoptTickedLabel, ReadOnlyReason, TickBox, useTicked } from "@/components/adopt-consent";
import { openList, openRow } from "@/components/list";
import { McpAdoptDialog } from "@/components/mcp-adopt-dialog";
import { RowText } from "@/components/row-text";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/** A definition in one line: the command it runs or the URL it calls. */
export const definitionSummary = (definition: McpDefinition) =>
  definition.transport === "stdio"
    ? [definition.command, ...(definition.args ?? [])].join(" ")
    : `${definition.transport} ${definition.url ?? ""}`;

type Ticked = ReturnType<typeof useTicked>;

/** A row's tick box, read-only reason and Adopt button, which follow whether it can be adopted (ADR-0007). */
function useConsent(finding: GlobalMcpServer | ProjectMcpEntry, ticked: Ticked, onAdopt: (ids: string[]) => void) {
  return {
    tick: (
      <TickBox
        name={finding.name}
        adoptable={finding.adoptable}
        checked={ticked.has(finding.id)}
        onChange={(on) => ticked.toggle(finding.id, on)}
      />
    ),
    tone: finding.adoptable ? ("warning" as const) : ("off" as const),
    reason: finding.notAdoptableReason && (
      <ReadOnlyReason reason={finding.notAdoptableReason} owner={finding.owningAgent} />
    ),
    adopt: finding.adoptable && (
      <Button size="sm" variant="outline" onClick={() => onAdopt([finding.id])}>
        Adopt
      </Button>
    ),
  };
}

/** The section's lead, and the button that Adopts what's ticked in it. */
function Actions({
  testId,
  ticked,
  onAdopt,
  children,
}: {
  testId: string;
  ticked: Ticked;
  onAdopt: (ids: string[]) => void;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex items-start gap-4">
      <p className="flex-1 text-muted-foreground text-body">{children}</p>
      <Button size="sm" disabled={ticked.ids.length === 0} onClick={() => onAdopt(ticked.ids)}>
        {adoptTickedLabel(ticked.ids.length)}
      </Button>
    </div>
  );
}

function Finding({
  finding,
  onAdopt,
  ticked,
}: {
  finding: GlobalMcpServer;
  onAdopt: (ids: string[]) => void;
  ticked: Ticked;
}) {
  const trpc = useTRPC();
  const ignore = useMutation(trpc.inbox.ignore.mutationOptions());
  const consent = useConsent(finding, ticked, onAdopt);
  return (
    <div data-testid="inbox-mcp-finding" className={cn("flex min-h-14 items-center gap-3 py-2.5", openRow)}>
      {consent.tick}
      <StatusDot tone={consent.tone} />
      <RowText
        title={finding.name}
        chips={
          finding.inlineSecrets.length > 0 && (
            <Chip tone="warning">
              {finding.inlineSecrets.length} inline secret{finding.inlineSecrets.length === 1 ? "" : "s"}
            </Chip>
          )
        }
        detail={definitionSummary(finding.definition)}
      >
        {consent.reason}
      </RowText>
      <div className="flex gap-1.5">
        <Button size="sm" variant="ghost" disabled={ignore.isPending} onClick={() => ignore.mutate({ id: finding.id })}>
          Ignore
        </Button>
        {consent.adopt}
      </div>
    </div>
  );
}

/** The Inbox's Global MCP Servers, one group per Agent config file, with Adopt. */
export function InboxMcpServers({ groups }: { groups: InboxMcpGroup[] }) {
  const [adopting, setAdopting] = useState<string[] | null>(null);
  const findings = groups.flatMap((group) => group.findings);
  const ticked = useTicked(findings.filter((finding) => finding.adoptable).map((finding) => finding.id));
  if (groups.length === 0) return null;
  return (
    <>
      <div className="flex flex-col gap-1 pt-2">
        <h2 className="font-semibold text-heading">Global MCP Servers</h2>
        <Actions testId="inbox-mcp-actions" ticked={ticked} onAdopt={setAdopting}>
          These load their tools into every Project. Tick the ones to Adopt into the Library so each Project asks for
          only what it needs; inline secrets move into the keychain.
        </Actions>
      </div>
      {groups.map((group) => (
        <section key={group.file} data-testid="inbox-mcp-group" className="flex flex-col gap-3">
          <h2 className="flex flex-wrap items-center gap-2 font-semibold text-section">
            <span className="font-mono">{group.file}</span>
            <span className="font-normal text-muted-foreground text-meta tabular-nums">{group.findings.length}</span>
            <span className="ml-auto flex items-center gap-1">
              <Chip>{agentName(group.agent)}</Chip>
            </span>
          </h2>
          <div className={openList}>
            {group.findings.map((finding) => (
              <Finding key={finding.id} finding={finding} onAdopt={setAdopting} ticked={ticked} />
            ))}
          </div>
        </section>
      ))}
      <McpAdoptDialog findings={adopting} onClose={() => setAdopting(null)} onAdopted={ticked.clear} />
    </>
  );
}

function UntrackedFinding({
  finding,
  onAdopt,
  ticked,
}: {
  finding: ProjectMcpEntry;
  onAdopt: (ids: string[]) => void;
  ticked: Ticked;
}) {
  const trpc = useTRPC();
  const ignore = useMutation(trpc.inbox.ignore.mutationOptions());
  const consent = useConsent(finding, ticked, onAdopt);
  return (
    <div data-testid="inbox-untracked-mcp-finding" className={cn("flex min-h-14 items-center gap-3 py-2.5", openRow)}>
      {consent.tick}
      <StatusDot tone={consent.tone} />
      <RowText
        title={finding.name}
        chips={<Chip>{agentName(finding.agent)}</Chip>}
        detail={`${finding.file} · ${definitionSummary(finding.definition)}`}
      >
        {consent.reason}
      </RowText>
      <div className="flex gap-1.5">
        <Button size="sm" variant="ghost" disabled={ignore.isPending} onClick={() => ignore.mutate({ id: finding.id })}>
          Ignore
        </Button>
        {consent.adopt}
      </div>
    </div>
  );
}

/**
 * Untracked Project MCP entries (#39 carry-over), one group per Project:
 * Adopt moves each definition into the Library and keeps it in the Project as
 * Personal, so its Agents see no change.
 */
export function InboxUntrackedMcpServers({ groups }: { groups: InboxProjectMcpGroup[] }) {
  const [adopting, setAdopting] = useState<string[] | null>(null);
  const findings = groups.flatMap((group) => group.findings);
  const ticked = useTicked(findings.filter((finding) => finding.adoptable).map((finding) => finding.id));
  if (groups.length === 0) return null;
  return (
    <>
      <div className="flex flex-col gap-1 pt-2">
        <h2 className="font-semibold text-heading">Untracked Project MCP Servers</h2>
        <Actions testId="inbox-untracked-mcp-actions" ticked={ticked} onAdopt={setAdopting}>
          MCP Servers in a Project's own config that Dark Matter didn't write and git doesn't track. Tick the ones to
          Adopt: each moves into the Library and stays in the Project as Personal; inline secrets move into the
          keychain.
        </Actions>
      </div>
      {groups.map((group) => (
        <section key={group.project} data-testid="inbox-untracked-mcp-group" className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 font-semibold text-section">
            {group.name}
            <span className="font-normal text-muted-foreground text-meta tabular-nums">{group.findings.length}</span>
          </h2>
          <div className={openList}>
            {group.findings.map((finding) => (
              <UntrackedFinding key={finding.id} finding={finding} onAdopt={setAdopting} ticked={ticked} />
            ))}
          </div>
        </section>
      ))}
      <McpAdoptDialog findings={adopting} onClose={() => setAdopting(null)} onAdopted={ticked.clear} />
    </>
  );
}
