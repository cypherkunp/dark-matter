import type { AdoptOutcome, AdoptPlan, AgentId, GlobalSkill } from "@dark-matter/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { AddToProjectsDialog } from "@/components/add-to-projects";
import { ConsentError, ReadOnlyReason, TickBox, useTicked } from "@/components/adopt-consent";
import { stepText } from "@/components/adopt-dialog";
import { AdoptPermissionSwitch } from "@/components/agents-settings";
import { Inventory } from "@/components/inventory";
import { plural } from "@/components/skill-list";
import { Button } from "@/components/ui/button";
import { agentName } from "@/lib/agents";
import { tildify } from "@/lib/paths";
import { useTRPC } from "@/lib/trpc";

const steps = ["welcome", "found", "adopt", "summary", "projects", "setup", "done"] as const;
type Step = (typeof steps)[number];

/**
 * The First run (#46, decided in #18): ask to Scan, show what was found, tick
 * the Global Skills to Adopt and confirm the plan (nothing pre-selected,
 * ADR-0007; skipped when there are none), a summary, confirm Suggested
 * Projects, set each up, then Start at login. Every step can be skipped; what's
 * left waits in the Inbox, and unconfirmed Projects stay under Suggested.
 * The step lives in the URL; completion lives in `settings.json`.
 */
export const Route = createFileRoute("/first-run")({
  validateSearch: (search: Record<string, unknown>): { step: Step; at?: number } => ({
    step: steps.includes(search.step as Step) ? (search.step as Step) : "welcome",
    ...(typeof search.at === "number" ? { at: search.at } : {}),
  }),
  component: FirstRun,
});

function useStep() {
  const navigate = useNavigate();
  return (step: Step, at?: number) =>
    navigate({ to: "/first-run", search: at === undefined ? { step } : { step, at } });
}

function Frame({
  title,
  lead,
  children,
  actions,
}: {
  title: string;
  lead?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
}) {
  const go = useStep();
  const { step } = Route.useSearch();
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 px-10 py-12">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-muted-foreground text-meta">
          First run · {steps.indexOf(step) + 1} of {steps.length}
        </p>
        <h1 className="font-bold text-display">{title}</h1>
        {lead && <div className="text-muted-foreground text-body leading-relaxed">{lead}</div>}
      </div>
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">{children}</div>
      <div className="mt-auto flex items-center justify-end gap-2 border-t pt-4">
        {step !== "done" && (
          <Button variant="ghost" className="mr-auto" onClick={() => go("done")}>
            Skip the rest
          </Button>
        )}
        {actions}
      </div>
    </div>
  );
}

function Welcome() {
  const trpc = useTRPC();
  const go = useStep();
  const scan = useMutation(trpc.scan.run.mutationOptions({ onSuccess: () => go("found") }));
  return (
    <Frame
      title="Skills belong to Projects"
      lead={
        <>
          <p>
            Dark Matter keeps your Skills in one Library and adds each to the Projects that need it, instead of every
            Agent loading every Skill everywhere.
          </p>
          <p className="mt-2">
            To start, it can Scan this computer: the Agents' Skill folders and settings, and the folders their history
            names. Nothing is read until you agree, and the Scan changes nothing.
          </p>
        </>
      }
      actions={
        <Button disabled={scan.isPending} onClick={() => scan.mutate()}>
          {scan.isPending ? "Scanning…" : "Scan my computer"}
        </Button>
      }
    >
      {scan.error && <p className="text-body text-status-warning">{scan.error.message}</p>}
    </Frame>
  );
}

/**
 * The Global Skills the Adopt step offers. The step is skipped when there are
 * none: then nothing could be ticked, even after turning an Adopt Permission
 * on in its panel. When there are some but none can be ticked yet, the step
 * still shows, so its panel can allow them (ADR-0007).
 */
const offeredSkills = (inbox: { globalSkills: { findings: GlobalSkill[] }[] } | undefined) =>
  (inbox?.globalSkills ?? []).flatMap((group) => group.findings);

function Found() {
  const trpc = useTRPC();
  const go = useStep();
  const inbox = useQuery(trpc.inbox.list.queryOptions());
  return (
    <Frame
      title="What the Scan found"
      lead="Every Skill and MCP Server your Agents can see today, by the folder that holds it. Read-only ones stay where they are."
      actions={
        <Button disabled={!inbox.data} onClick={() => go(offeredSkills(inbox.data).length > 0 ? "adopt" : "projects")}>
          Continue
        </Button>
      }
    >
      <Inventory empty="No Skills or MCP Servers found outside the Library." />
    </Frame>
  );
}

const outcomeLabels: Record<AdoptOutcome, string> = {
  moved: "move",
  merged: "identical copy, merged",
  variant: "Name Conflict, kept side by side",
  localSource: "Local Source",
};

/** The Adopt Permissions for the Agents that own the offered Skills, inline (same settings as Settings › Agents). */
function AdoptPermissionsPanel({ owners }: { owners: AgentId[] }) {
  return (
    <section data-testid="first-run-adopt-permissions" className="flex flex-col gap-2 rounded-xl border px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-body">Adopt Permissions</span>
        <span className="text-muted-foreground text-meta">
          Dark Matter only moves Skills out of an Agent's own folder when you allow it. You can change this later in
          Settings › Agents.
        </span>
      </div>
      {owners.map((agent) => (
        <div key={agent} className="flex items-center gap-3">
          <span className="flex-1 text-body">Skills in {agentName(agent)}'s folder</span>
          <AdoptPermissionSwitch agent={agent} kind="skills" />
        </div>
      ))}
    </section>
  );
}

const ownerOrder: AgentId[] = ["agents", "claude-code", "cursor", "opencode", "codex"];

function Adopt({ onAdopted }: { onAdopted: (plan: AdoptPlan) => void }) {
  const trpc = useTRPC();
  const go = useStep();
  const inbox = useQuery(trpc.inbox.list.queryOptions());
  const offered = offeredSkills(inbox.data);
  const ticked = useTicked(offered.filter((finding) => finding.adoptable).map((finding) => finding.id));
  const findings = ticked.ids;
  const owners = ownerOrder.filter((agent) => offered.some((finding) => finding.owningAgent === agent));
  const plan = useQuery({
    ...trpc.adopt.plan.queryOptions({ findings }),
    enabled: findings.length > 0,
    staleTime: 0,
    gcTime: 0,
  });
  const execute = useMutation(
    trpc.adopt.execute.mutationOptions({
      onSuccess: (applied) => {
        onAdopted(applied);
        void go("summary");
      },
      onError: () => void plan.refetch(),
    }),
  );
  const error = findings.length > 0 ? (plan.error ?? execute.error) : null;
  const shown = findings.length > 0 ? plan.data : undefined;
  // Skipped when there's nothing it could offer (ADR-0007), however it was reached: Found's Continue, Back, or a link.
  if (inbox.data && offered.length === 0 && execute.isIdle)
    return <Navigate to="/first-run" search={{ step: "projects" }} replace />;
  return (
    <Frame
      title="Move Global Skills into the Library"
      lead="Tick the Skills to move, check the plan, then confirm. Each moves into the Library: nothing is deleted, and Undo Adopt puts it back."
      actions={
        <>
          <Button variant="outline" disabled={execute.isPending} onClick={() => go("projects")}>
            Keep them in the Inbox
          </Button>
          {findings.length > 0 && (
            <Button
              disabled={!shown || execute.isPending}
              onClick={() => shown && execute.mutate({ findings: shown.findings, planId: shown.planId })}
            >
              {execute.isPending ? "Adopting…" : `Adopt ${plural(findings.length, "Global Skill")}`}
            </Button>
          )}
        </>
      }
    >
      <div data-testid="first-run-adopt" className="flex flex-col gap-4">
        {owners.length > 0 && <AdoptPermissionsPanel owners={owners} />}
        {offered.length > 0 && (
          <div className="divide-y rounded-xl border">
            {offered.map((finding) => (
              <div key={finding.id} data-testid="first-run-adopt-skill" className="flex items-start gap-3 px-4 py-2.5">
                <span className="pt-0.5">
                  <TickBox
                    name={finding.name}
                    adoptable={finding.adoptable}
                    checked={ticked.has(finding.id)}
                    onChange={(on) => ticked.toggle(finding.id, on)}
                  />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium text-body">{finding.name}</span>
                  <span className="truncate font-mono text-muted-foreground text-meta">{finding.folder}</span>
                  {finding.notAdoptableReason && (
                    <ReadOnlyReason reason={finding.notAdoptableReason} owner={finding.owningAgent} />
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {shown?.warnings.map((warning) => (
          <div
            key={warning}
            className="flex gap-2.5 rounded-xl border border-warning-border bg-warning-surface px-4 py-3 text-body"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" />
            <span>{warning}</span>
          </div>
        ))}
        {shown && (
          <>
            <div className="divide-y rounded-xl border">
              {shown.skills.map((skill) => (
                <div key={skill.finding} className="flex items-center gap-2 px-4 py-2.5">
                  <span className="font-medium text-body">{skill.name}</span>
                  <span className="rounded-md border px-1.5 py-0.5 font-mono text-micro text-muted-foreground">
                    {skill.key}
                  </span>
                  <span className="ml-auto text-muted-foreground text-meta">{outcomeLabels[skill.outcome]}</span>
                </div>
              ))}
            </div>
            <details open className="text-meta">
              <summary className="cursor-default text-muted-foreground">Dry-run plan</summary>
              <ol className="mt-2 flex flex-col gap-1 font-mono text-micro text-muted-foreground">
                {shown.steps.map((step) => (
                  <li key={stepText(step)}>{stepText(step)}</li>
                ))}
              </ol>
            </details>
          </>
        )}
        {execute.isPending && <p className="text-body">Moving {plural(findings.length, "Skill")}…</p>}
        <ConsentError error={error} />
      </div>
    </Frame>
  );
}

function Summary({ applied }: { applied: AdoptPlan | null }) {
  const go = useStep();
  const count = (outcome: AdoptOutcome) => applied?.skills.filter((skill) => skill.outcome === outcome).length ?? 0;
  const lines = [
    `${count("moved")} moved into the Library`,
    `${count("merged")} merged with an identical copy`,
    `${plural(count("variant"), "Name Conflict")} kept side by side`,
    `${plural(count("localSource"), "external symlink")} now a Local Source`,
  ];
  return (
    <Frame
      title="Done: your Global Skills are in the Library"
      lead="Agents see them again once a Project adds them. That's next."
      actions={<Button onClick={() => go("projects")}>Continue</Button>}
    >
      <ul data-testid="first-run-summary" className="divide-y rounded-xl border text-body">
        {(applied ? lines : ["Nothing was moved"]).map((line) => (
          <li key={line} className="px-4 py-2.5">
            {line}
          </li>
        ))}
      </ul>
    </Frame>
  );
}

function Projects() {
  const trpc = useTRPC();
  const go = useStep();
  const suggested = useQuery(trpc.project.suggested.queryOptions());
  const list = suggested.data?.suggested ?? [];
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const chosen = list.filter((suggestion) => !skipped.has(suggestion.path));
  const add = useMutation(trpc.project.add.mutationOptions());
  // Confirmed Projects are part of the next Scan, so their untracked Skills reach the Inbox.
  const rescan = useMutation(trpc.scan.run.mutationOptions());
  const busy = add.isPending || rescan.isPending;
  const confirm = async () => {
    for (const suggestion of chosen) await add.mutateAsync({ path: suggestion.path });
    await rescan.mutateAsync();
    void go("setup", 0);
  };
  return (
    <Frame
      title="Confirm your Projects"
      lead="Folders your Agents worked in. Dark Matter only manages the ones you confirm; the rest stay under Suggested."
      actions={
        list.length === 0 ? (
          <Button onClick={() => go("setup", 0)}>Continue</Button>
        ) : (
          <Button disabled={busy || chosen.length === 0} onClick={() => void confirm()}>
            {busy ? "Confirming…" : `Confirm ${plural(chosen.length, "Project")}`}
          </Button>
        )
      }
    >
      {suggested.data && list.length === 0 && (
        <p className="text-muted-foreground text-body">No Suggested Projects. Add folders later from the sidebar.</p>
      )}
      {list.length > 0 && (
        <div className="divide-y rounded-xl border">
          {list.map((suggestion) => (
            <label
              key={suggestion.path}
              data-testid="first-run-project"
              className="flex cursor-pointer items-center gap-3 px-4 py-3"
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={!skipped.has(suggestion.path)}
                onChange={() =>
                  setSkipped((current) => {
                    const next = new Set(current);
                    if (next.has(suggestion.path)) next.delete(suggestion.path);
                    else next.add(suggestion.path);
                    return next;
                  })
                }
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-body">{suggestion.name}</span>
                <span className="truncate font-mono text-muted-foreground text-meta">
                  {tildify(suggestion.path)} · seen in {suggestion.agents.map((agent) => agentName(agent)).join(", ")}
                </span>
              </div>
            </label>
          ))}
        </div>
      )}
      {add.error && <p className="text-body text-status-warning">{add.error.message}</p>}
    </Frame>
  );
}

function Setup({ at }: { at: number }) {
  const trpc = useTRPC();
  const go = useStep();
  const projects = useQuery(trpc.project.list.queryOptions());
  const library = useQuery(trpc.library.list.queryOptions());
  const collections = useQuery(trpc.collections.list.queryOptions());
  const list = (projects.data ?? []).filter((project) => project.exists);
  const project = list[at];
  const skills = useQuery({
    ...trpc.project.skills.queryOptions({ path: project?.path ?? "" }),
    enabled: project !== undefined,
  });
  const [open, setOpen] = useState<{ keys: string[]; servers?: string[]; collection?: string } | null>(null);
  if (projects.isPending) return null;
  if (!project)
    return (
      <Frame
        title="No Projects to set up"
        lead="Confirm a Suggested Project or add a folder later, then add Skills from its page."
        actions={<Button onClick={() => go("done")}>Continue</Button>}
      />
    );
  const last = at >= list.length - 1;
  const keys = (library.data?.skills ?? []).map((skill) => skill.key);
  return (
    <Frame
      title={`Set up ${project.name}`}
      lead={`Project ${at + 1} of ${list.length}. Pick the Skills ${project.name} needs, or add a Collection. ${plural(skills.data?.length ?? 0, "Skill")} in it so far.`}
      actions={
        <Button onClick={() => (last ? go("done") : go("setup", at + 1))}>{last ? "Finish" : "Next Project"}</Button>
      }
    >
      <ul data-testid="first-run-modes" className="flex flex-col gap-1.5 rounded-xl border px-4 py-3 text-body">
        <li>
          <span className="font-medium">Link</span>: a personal symlink to the Library, excluded from git. Only you get
          it.
        </li>
        <li>
          <span className="font-medium">Copy</span>: real files committed in the repo, so your team gets it too.
        </li>
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={keys.length === 0} onClick={() => setOpen({ keys })}>
          Pick Skills
        </Button>
        {(collections.data ?? []).map((collection) => (
          <Button
            key={collection.name}
            variant="outline"
            onClick={() =>
              setOpen({
                collection: collection.name,
                keys: collection.items.flatMap((item) => (item.kind === "skill" ? [item.key] : [])),
                // A Collection's MCP Servers come too (story 92).
                servers: collection.items.flatMap((item) => (item.kind === "mcpServer" ? [item.name] : [])),
              })
            }
          >
            Add {collection.name}
          </Button>
        ))}
      </div>
      {keys.length === 0 && (
        <p className="text-muted-foreground text-body">The Library is empty, so there's nothing to add yet.</p>
      )}
      <p className="text-muted-foreground text-meta">
        Skills already in this repo and not committed wait in the Inbox.
      </p>
      {open && (
        <AddToProjectsDialog
          keys={open.keys}
          servers={open.servers ?? []}
          projects={[project.path]}
          {...(open.collection ? { collection: open.collection } : {})}
          title={open.collection ? `Add ${open.collection} to ${project.name}` : `Add Skills to ${project.name}`}
          onClose={() => setOpen(null)}
        />
      )}
    </Frame>
  );
}

function Done() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const [startAtLogin, setStartAtLogin] = useState<boolean | null>(null);
  const checked = startAtLogin ?? settings.data?.preferences.startAtLogin ?? true;
  const save = useMutation(trpc.settings.updatePreferences.mutationOptions());
  const complete = useMutation(
    trpc.settings.completeFirstRun.mutationOptions({
      onSuccess: (saved) => {
        // The shell checks this before leaving the First run.
        queryClient.setQueryData(trpc.settings.get.queryKey(), saved);
        void navigate({ to: "/library" });
      },
    }),
  );
  const finish = async () => {
    if (checked !== settings.data?.preferences.startAtLogin) await save.mutateAsync({ startAtLogin: checked });
    complete.mutate();
  };
  return (
    <Frame
      title="You're set"
      lead="Anything left over waits in the Inbox, and Projects you didn't confirm stay under Suggested."
      actions={
        <Button disabled={save.isPending || complete.isPending} onClick={() => void finish()}>
          Open the Library
        </Button>
      }
    >
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={checked}
          onChange={(event) => setStartAtLogin(event.target.checked)}
          aria-label="Start at login"
        />
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-body">Start at login</span>
          <span className="text-muted-foreground text-meta">
            Keeps Dark Matter in the menu bar so the daily Scheduled Scan runs.
          </span>
        </div>
      </label>
      {(save.error ?? complete.error) && (
        <p className="text-body text-status-warning">{(save.error ?? complete.error)?.message}</p>
      )}
    </Frame>
  );
}

function FirstRun() {
  const { step, at } = Route.useSearch();
  // The Adopt result for the summary; lost on reload, when the summary says nothing was moved.
  const [applied, setApplied] = useState<AdoptPlan | null>(null);
  switch (step) {
    case "welcome":
      return <Welcome />;
    case "found":
      return <Found />;
    case "adopt":
      return <Adopt onAdopted={setApplied} />;
    case "summary":
      return <Summary applied={applied} />;
    case "projects":
      return <Projects />;
    case "setup":
      return <Setup at={at ?? 0} />;
    case "done":
      return <Done />;
  }
}
