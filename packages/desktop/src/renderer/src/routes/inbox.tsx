import type {
  AdoptPlan,
  GlobalSkill,
  InboxFolderGroup,
  InboxManagedGroup,
  InboxNewSkillsGroup,
  InboxProjectGroup,
  ManagedSkill,
  OffSwitch,
  UntrackedSkill,
} from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, Inbox as InboxIcon } from "lucide-react";
import { useState } from "react";
import { AddToProjectsDialog } from "@/components/add-to-projects";
import {
  adoptTickedLabel,
  ConsentError,
  guardedOffSwitchText,
  ReadOnlyReason,
  TickBox,
  useAgentConfigGuard,
  useTicked,
} from "@/components/adopt-consent";
import { AdoptDialog } from "@/components/adopt-dialog";
import { IgnoredFindings } from "@/components/ignored-findings";
import { InboxDrift } from "@/components/inbox-drift";
import { InboxMcpServers, InboxUntrackedMcpServers } from "@/components/inbox-mcp";
import { InboxRequests } from "@/components/inbox-requests";
import { ManagedMcpGroups } from "@/components/managed-mcp";
import { Page } from "@/components/page";
import { PageHead } from "@/components/page-head";
import { RowText } from "@/components/row-text";
import { StatusDot } from "@/components/status-dot";
import { Button, buttonVariants } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { useScan } from "@/components/use-scan";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";
import { relativeTime, useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/inbox")({ component: Inbox });

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

type Adopt = (findings: string[]) => void;

/** What's ticked to Adopt on the page, by finding id (ADR-0007: nothing until you tick it). */
type Ticked = ReturnType<typeof useTicked>;

function Finding({ finding, onAdopt, ticked }: { finding: GlobalSkill; onAdopt: Adopt; ticked: Ticked }) {
  const trpc = useTRPC();
  const ignore = useMutation(trpc.inbox.ignore.mutationOptions());
  const reachedFrom = finding.locations.filter((location) => location.path !== finding.realPath);
  return (
    <div data-testid="inbox-finding" className="flex min-h-14 items-center gap-3 px-5 py-2.5">
      <TickBox
        name={finding.name}
        adoptable={finding.adoptable}
        checked={ticked.has(finding.id)}
        onChange={(on) => ticked.toggle(finding.id, on)}
      />
      <StatusDot tone={finding.adoptable ? "warning" : "off"} />
      <RowText
        title={finding.name}
        chips={finding.localSource && <Chip mono>Local Source</Chip>}
        description={finding.description}
        detail={[finding.source, finding.realPath, ...reachedFrom.map((location) => `↖ ${location.path}`)]
          .filter(Boolean)
          .join(" · ")}
      >
        {finding.notAdoptableReason && (
          <ReadOnlyReason reason={finding.notAdoptableReason} owner={finding.owningAgent} />
        )}
      </RowText>
      <div className="flex gap-1.5">
        <Button size="sm" variant="ghost" disabled={ignore.isPending} onClick={() => ignore.mutate({ id: finding.id })}>
          Ignore
        </Button>
        {finding.adoptable && (
          <Button size="sm" variant="outline" onClick={() => onAdopt([finding.id])}>
            Adopt
          </Button>
        )}
      </div>
    </div>
  );
}

function FolderGroup({ group, onAdopt, ticked }: { group: InboxFolderGroup; onAdopt: Adopt; ticked: Ticked }) {
  return (
    <section data-testid="inbox-group" className="flex flex-col gap-3">
      <h2 className="flex flex-wrap items-center gap-2 font-semibold text-section">
        <span className="font-mono font-medium">{group.folder}</span>
        <span className="font-normal text-muted-foreground text-meta tabular-nums">{group.findings.length}</span>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {group.agents.map((agent) => (
            <Chip key={agent}>{agentName(agent)}</Chip>
          ))}
        </span>
      </h2>
      <div className="divide-y rounded-xl border">
        {group.findings.map((finding) => (
          <Finding key={finding.id} finding={finding} onAdopt={onAdopt} ticked={ticked} />
        ))}
      </div>
    </section>
  );
}

function UntrackedFinding({ finding, onAdopt, ticked }: { finding: UntrackedSkill; onAdopt: Adopt; ticked: Ticked }) {
  const trpc = useTRPC();
  const ignore = useMutation(trpc.inbox.ignore.mutationOptions());
  return (
    <div data-testid="inbox-untracked-finding" className="flex min-h-14 items-center gap-3 px-5 py-2.5">
      <TickBox
        name={finding.name}
        adoptable={finding.adoptable}
        checked={ticked.has(finding.id)}
        onChange={(on) => ticked.toggle(finding.id, on)}
      />
      <StatusDot tone={finding.adoptable ? "warning" : "off"} />
      <RowText
        title={finding.name}
        chips={finding.localSource && <Chip mono>Local Source</Chip>}
        description={finding.description}
        detail={finding.locations.map((location) => location.path).join(" · ")}
      >
        {finding.notAdoptableReason && (
          <ReadOnlyReason reason={finding.notAdoptableReason} owner={finding.owningAgent} />
        )}
      </RowText>
      <div className="flex gap-1.5">
        <Button size="sm" variant="ghost" disabled={ignore.isPending} onClick={() => ignore.mutate({ id: finding.id })}>
          Ignore
        </Button>
        {finding.adoptable && (
          <Button size="sm" variant="outline" onClick={() => onAdopt([finding.id])}>
            Adopt & keep Link
          </Button>
        )}
      </div>
    </div>
  );
}

/** "New Skills in ⭐ owner/repo" (#35): Skills a starred Source gained. Import is always your call. */
function NewSkillsGroup({ group }: { group: InboxNewSkillsGroup }) {
  const trpc = useTRPC();
  const ignore = useMutation(trpc.inbox.ignore.mutationOptions());
  return (
    <section data-testid="inbox-new-skills" className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-semibold text-section">
        New Skills in ⭐ <span className="font-mono font-medium">{group.source}</span>
        <span className="font-normal text-muted-foreground text-meta tabular-nums">{group.findings.length}</span>
        <Link
          to="/get/github"
          search={{ url: group.source }}
          className={cn(buttonVariants({ size: "sm", variant: "outline" }), "ml-auto")}
        >
          Import…
        </Link>
      </h2>
      <div className="divide-y rounded-xl border">
        {group.findings.map((finding) => (
          <div key={finding.id} data-testid="inbox-new-skill" className="flex min-h-14 items-center gap-3 px-5 py-2.5">
            <StatusDot tone="warning" />
            <RowText title={finding.name} detail={`${group.source}/${finding.path}`} />
            <Button
              size="sm"
              variant="ghost"
              disabled={ignore.isPending}
              onClick={() => ignore.mutate({ id: finding.id })}
            >
              Ignore
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProjectGroup({ group, onAdopt, ticked }: { group: InboxProjectGroup; onAdopt: Adopt; ticked: Ticked }) {
  return (
    <section data-testid="inbox-untracked-group" className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-semibold text-section">
        <Link to="/project" search={{ path: group.project }} className="hover:underline">
          {group.name}
        </Link>
        <span className="font-normal text-muted-foreground text-meta tabular-nums">{group.findings.length}</span>
      </h2>
      <div className="divide-y rounded-xl border">
        {group.findings.map((finding) => (
          <UntrackedFinding key={finding.id} finding={finding} onAdopt={onAdopt} ticked={ticked} />
        ))}
      </div>
    </section>
  );
}

const offLabel: Record<OffSwitch["scope"], string> = {
  skill: "Turn off everywhere",
  plugin: "Turn off plugin everywhere",
  bundled: "Turn off all bundled",
};

function ManagedFinding({ finding }: { finding: ManagedSkill }) {
  const trpc = useTRPC();
  const ignore = useMutation(trpc.inbox.ignore.mutationOptions());
  const turnOff = useMutation(trpc.managedSkills.turnOff.mutationOptions());
  const guarded = useAgentConfigGuard();
  const busy = ignore.isPending || turnOff.isPending;
  return (
    <div data-testid="inbox-managed-finding" className="flex min-h-14 items-center gap-3 px-5 py-2.5">
      <StatusDot tone="on" />
      <RowText
        title={finding.name}
        chips={<Chip mono>{finding.plugin ?? finding.kind}</Chip>}
        description={finding.description}
        detail={finding.path}
      >
        {finding.offSwitches.length === 0 && (
          <p className="text-muted-foreground text-meta">
            {agentName(finding.agent)} has no off switch for its own Skills, so Dark Matter only lists it.
          </p>
        )}
        {guarded && finding.offSwitches.length > 0 && (
          <p data-testid="guarded-reason" className="text-muted-foreground text-meta">
            {guardedOffSwitchText}
          </p>
        )}
        <ConsentError error={turnOff.error} className="text-status-warning text-meta" />
      </RowText>
      {finding.offSwitches.map((offSwitch) => (
        <Button
          key={offSwitch.scope}
          size="sm"
          variant="outline"
          disabled={busy || guarded}
          title={`Writes ${offSwitch.setting} in ${offSwitch.file}`}
          onClick={() => turnOff.mutate({ id: finding.id, scope: offSwitch.scope })}
        >
          {offLabel[offSwitch.scope]}
        </Button>
      ))}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => ignore.mutate({ id: finding.id })}>
        Ignore
      </Button>
    </div>
  );
}

function ManagedGroup({ group }: { group: InboxManagedGroup }) {
  return (
    <section data-testid="inbox-managed-group" className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-semibold text-section">
        <span>{agentName(group.agent)}</span>
        <span className="font-normal text-muted-foreground text-meta tabular-nums">{group.findings.length}</span>
      </h2>
      <div className="divide-y rounded-xl border">
        {group.findings.map((finding) => (
          <ManagedFinding key={finding.id} finding={finding} />
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
  const managed = inbox.data?.managedSkills ?? [];
  const untracked = inbox.data?.untrackedSkills ?? [];
  const projects = useQuery(trpc.project.list.queryOptions());
  const [granting, setGranting] = useState<string[] | null>(null);
  /** After Adopting Global Skills, offer them to Projects in one step (#10 point 8). */
  const adopted = (plan: AdoptPlan) => {
    const keys = plan.skills.filter((skill) => skill.finding.startsWith("global-skill:")).map((skill) => skill.key);
    if (keys.length > 0 && (projects.data ?? []).some((project) => project.exists))
      setGranting([...new Set(keys)].sort());
  };
  const count = inbox.data?.count ?? 0;
  const ignored = inbox.data?.ignoredCount ?? 0;
  const [adopting, setAdopting] = useState<string[] | null>(null);
  const skillFindings = [...groups.flatMap((group) => group.findings), ...untracked.flatMap((group) => group.findings)];
  const ticked = useTicked(skillFindings.filter((finding) => finding.adoptable).map((finding) => finding.id));

  return (
    <Page>
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
          <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <InboxIcon className="size-5" />
          </div>
          <h2 className="font-semibold text-heading">{lastScanAt ? "Nothing waiting on you" : "No Scan yet"}</h2>
          <p className="max-w-sm text-muted-foreground text-body">
            A Scan reads every Agent's global skill folders and lists the Global Skills it finds here. It never changes
            anything.
          </p>
          <Button size="sm" variant="outline" disabled={scanning} onClick={scan}>
            {scanning ? "Scanning…" : "Scan now"}
          </Button>
        </section>
      ) : (
        <>
          {(inbox.data?.suggestedProjects ?? 0) > 0 && (
            <Link
              to="/projects/suggested"
              data-testid="inbox-suggested-projects"
              className="flex min-h-16 items-center gap-3 rounded-xl border px-5 py-3 hover:bg-muted/50"
            >
              <StatusDot tone="warning" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-body">
                  {plural(inbox.data?.suggestedProjects ?? 0, "Suggested Project")}
                </span>
                <span className="text-muted-foreground text-meta">Confirm the folders Dark Matter should manage</span>
              </div>
              <ChevronRight className="size-4 text-muted-foreground" />
            </Link>
          )}
          <InboxRequests requests={inbox.data?.requests ?? []} />
          <InboxDrift groups={inbox.data?.drift ?? []} />
          {skillFindings.length > 0 && (
            <div data-testid="inbox-skills-actions" className="flex items-start gap-4">
              <p className="flex-1 text-muted-foreground text-body">
                {groups.length > 0
                  ? "Global Skills load in every Project. Tick the ones to Adopt into the Library so each Project asks for only what it needs."
                  : "Tick the Skills to Adopt into the Library."}
              </p>
              <Button size="sm" disabled={ticked.ids.length === 0} onClick={() => setAdopting(ticked.ids)}>
                {adoptTickedLabel(ticked.ids.length)}
              </Button>
            </div>
          )}
          {groups.map((group) => (
            <FolderGroup key={group.folder} group={group} onAdopt={setAdopting} ticked={ticked} />
          ))}
          {untracked.length > 0 && (
            <>
              <div className="flex flex-col gap-1 pt-2">
                <h2 className="font-semibold text-heading">Untracked Project Skills</h2>
                <p className="text-muted-foreground text-body">
                  Skills in a Project's skill folders that git doesn't track. Adopt & keep Link moves each into the
                  Library and puts a Link back, On, so the Project sees no change.
                </p>
              </div>
              {untracked.map((group) => (
                <ProjectGroup key={group.project} group={group} onAdopt={setAdopting} ticked={ticked} />
              ))}
            </>
          )}
          {managed.length > 0 && (
            <>
              <div className="flex flex-col gap-1 pt-2">
                <h2 className="font-semibold text-heading">Agent-managed Skills</h2>
                <p className="text-muted-foreground text-body">
                  Plugins, built-ins and bundled Skills each Agent installs itself. Dark Matter can't move them, but can
                  turn them off through the Agent's own settings.
                </p>
              </div>
              {managed.map((group) => (
                <ManagedGroup key={group.agent} group={group} />
              ))}
            </>
          )}
          {(inbox.data?.newSkills ?? []).map((group) => (
            <NewSkillsGroup key={group.source} group={group} />
          ))}
          <InboxMcpServers groups={inbox.data?.mcpServers ?? []} />
          <InboxUntrackedMcpServers groups={inbox.data?.untrackedMcpServers ?? []} />
          <ManagedMcpGroups groups={inbox.data?.managedMcpServers ?? []} inInbox />
        </>
      )}
      <IgnoredFindings count={ignored} />
      <AdoptDialog
        findings={adopting}
        onClose={() => setAdopting(null)}
        onAdopted={(plan) => {
          ticked.clear();
          adopted(plan);
        }}
      />
      {granting && (
        <AddToProjectsDialog
          keys={granting}
          description="Agents see Adopted Skills only where a Project adds them. Tick what each Project needs; each becomes a Link."
          onClose={() => setGranting(null)}
        />
      )}
    </Page>
  );
}
