import { Dialog } from "@base-ui/react/dialog";
import type { McpChangeInput, McpDeliveryMode, ProjectMcpServer } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound, Plus, TriangleAlert, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { adoptTickedLabel, ReadOnlyReason, TickBox, useTicked } from "@/components/adopt-consent";
import { ConfirmDialog } from "@/components/copy-actions";
import { definitionSummary } from "@/components/inbox-mcp";
import { McpAdoptDialog } from "@/components/mcp-adopt-dialog";
import { OnOffSwitch } from "@/components/project-skills";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const modeLabels: Record<McpDeliveryMode, string> = { personal: "Personal", shared: "Shared" };

type Delivery = ProjectMcpServer["deliveries"][number];

const deliveryText = ({ agent, file, status }: Delivery) =>
  status === "tracked"
    ? `${agentName(agent)}: not offered, ${file} is tracked by git`
    : `${agentName(agent)} ${file}${status === "off" ? " (off)" : ""}`;

/** What the Agent still needs before it loads a delivered entry (#39). */
const approvalText = ({ agent, approval }: Delivery) =>
  approval === "untrusted"
    ? "delivered, inactive: Project not trusted in Codex"
    : approval === "needsApproval"
      ? `needs approval in ${agentName(agent)}`
      : null;

const Warning = ({ children }: { children: ReactNode }) => (
  <div className="flex gap-2.5 rounded-xl border border-warning-border bg-warning-surface px-4 py-3 text-body">
    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" />
    <div className="flex flex-col gap-1">{children}</div>
  </div>
);

/** The env vars each teammate must set for a Shared server. */
function EnvVars({ vars }: { vars: string[] }) {
  if (vars.length === 0)
    return <p className="text-muted-foreground text-meta">Teammates don't need to set anything.</p>;
  return (
    <p data-testid="mcp-env-vars" className="text-muted-foreground text-meta">
      Each teammate sets <span className="font-mono text-foreground">{vars.join(", ")}</span> in their environment.
    </p>
  );
}

/** The dry run of one change: its edits, env vars and the team-change warning. */
function PlanSummary({ input }: { input: McpChangeInput }) {
  const trpc = useTRPC();
  const plan = useQuery({ ...trpc.project.mcpPlan.queryOptions(input), staleTime: 0, gcTime: 0 });
  if (plan.error) return <p className="text-status-warning text-meta">{plan.error.message}</p>;
  if (!plan.data) return null;
  return (
    <div data-testid="mcp-plan" className="flex flex-col gap-2">
      {plan.data.teamChange && (
        <Warning>
          <span className="font-medium">This is a team change.</span>
          <span className="text-muted-foreground">
            It edits committed config: everyone who pulls it gets the change.
          </span>
        </Warning>
      )}
      {(input.mode ?? "") === "shared" && <EnvVars vars={plan.data.envVars} />}
      <ul className="flex flex-col gap-0.5 font-mono text-muted-foreground text-meta">
        {plan.data.edits.map((edit) => (
          <li key={`${edit.file} ${edit.change}`} data-testid="mcp-plan-edit">
            {edit.file}: {edit.change}
          </li>
        ))}
        {plan.data.edits.length === 0 && <li>Nothing to write.</li>}
      </ul>
    </div>
  );
}

type Pending =
  | { kind: "off" }
  | { kind: "remove" }
  | { kind: "mode"; mode: McpDeliveryMode }
  | { kind: "take" }
  | { kind: "trust" }
  | null;

function ProjectMcpServerRow({ path, server }: { path: string; server: ProjectMcpServer }) {
  const trpc = useTRPC();
  const [pending, setPending] = useState<Pending>(null);
  const close = { onSuccess: () => setPending(null) };
  const setOn = useMutation(trpc.project.setMcpServerOn.mutationOptions(close));
  const remove = useMutation(trpc.project.removeMcpServer.mutationOptions(close));
  const setMode = useMutation(trpc.project.setMcpServerMode.mutationOptions(close));
  const update = useMutation(trpc.project.updateMcpServer.mutationOptions(close));
  const pull = useMutation(trpc.project.pullMcpServer.mutationOptions());
  const trust = useMutation(trpc.project.trustInCodex.mutationOptions(close));
  const mutations = [setOn, remove, setMode, update, pull, trust];
  const busy = mutations.some((mutation) => mutation.isPending);
  const error = mutations.find((mutation) => mutation.error)?.error;
  const shared = server.mode === "shared";
  const modified = server.deliveries.filter((delivery) => delivery.status === "modifiedInRepo");
  /** Personal entries edited by hand (story 104): kept until you choose. */
  const handEdited = server.deliveries.filter((delivery) => delivery.status === "modified");
  const outdated = server.deliveries.some((delivery) => delivery.status === "outdated");
  const untrusted = server.deliveries.some((delivery) => delivery.approval === "untrusted");
  const discardEdits = modified.length > 0 || handEdited.length > 0;
  /** Off and Remove ask first for a team change, or when they'd discard a hand edit. */
  const asks = shared || handEdited.length > 0;
  const name = server.name;
  const reset = () => {
    for (const mutation of mutations) mutation.reset();
    setPending(null);
  };

  return (
    <div data-testid="project-mcp-row" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <StatusDot tone={server.on ? "on" : "off"} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-body">{name}</span>
          <Chip mono data-testid="project-mcp-mode">
            {modeLabels[server.mode]}
          </Chip>
          {server.secrets.length > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground text-meta">
              <KeyRound className="size-3" />
              {plural(server.secrets.length, "Secret")}
            </span>
          )}
          {outdated && (
            <span data-testid="mcp-outdated" className="text-status-warning text-meta">
              outdated
            </span>
          )}
          {modified.length > 0 && (
            <span data-testid="mcp-modified" className="text-status-warning text-meta">
              modified in repo
            </span>
          )}
          {handEdited.length > 0 && (
            <span data-testid="mcp-hand-edited" className="text-status-warning text-meta">
              edited by hand
            </span>
          )}
        </div>
        {shared && server.envVars && <EnvVars vars={server.envVars} />}
        {server.deliveries.length === 0 ? (
          <p className="text-muted-foreground text-meta">None of this Project's Agents read MCP Servers.</p>
        ) : (
          server.deliveries.map((delivery) => (
            <div
              key={delivery.agent}
              data-testid="project-mcp-delivery"
              className="truncate font-mono text-muted-foreground text-meta"
            >
              {deliveryText(delivery)}
              {approvalText(delivery) && (
                <span data-testid="mcp-approval" className="ml-2 font-sans text-status-warning">
                  {approvalText(delivery)}
                </span>
              )}
            </div>
          ))
        )}
        {error && <p className="text-status-warning text-meta">{error.message}</p>}
        <div className="flex flex-wrap gap-1">
          {handEdited.length > 0 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setPending({ kind: "take" })}>
              Take Library version
            </Button>
          )}
          {outdated && modified.length === 0 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => update.mutate({ path, name })}>
              Update
            </Button>
          )}
          {modified.length > 0 && (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setPending({ kind: "take" })}>
                Take Library version
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => modified[0] && pull.mutate({ path, name, agent: modified[0].agent })}
              >
                Pull into Library
              </Button>
            </>
          )}
          {untrusted && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setPending({ kind: "trust" })}>
              Trust in Codex…
            </Button>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => setPending({ kind: "mode", mode: shared ? "personal" : "shared" })}
      >
        Make {shared ? "Personal" : "Shared"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => (asks ? setPending({ kind: "remove" }) : remove.mutate({ path, name }))}
      >
        Remove
      </Button>
      <OnOffSwitch
        on={server.on}
        disabled={busy}
        label={`${name} On`}
        onChange={(on) => (asks && !on ? setPending({ kind: "off" }) : setOn.mutate({ path, name, on }))}
      />
      {pending?.kind === "off" && (
        <ConfirmDialog
          title={shared ? `Turn off ${name} for the team?` : `Turn off ${name} and discard the hand edit?`}
          confirm="Turn Off"
          busy={busy}
          error={setOn.error?.message}
          onConfirm={() => setOn.mutate({ path, name, on: false, discardEdits })}
          onClose={reset}
        >
          <PlanSummary input={{ path, name, on: false, discardEdits }} />
        </ConfirmDialog>
      )}
      {pending?.kind === "remove" && (
        <ConfirmDialog
          title={shared ? `Remove ${name} for the team?` : `Remove ${name} and discard the hand edit?`}
          confirm="Remove"
          busy={busy}
          error={remove.error?.message}
          onConfirm={() => remove.mutate({ path, name, discardEdits })}
          onClose={reset}
        >
          <PlanSummary input={{ path, name, remove: true, discardEdits }} />
        </ConfirmDialog>
      )}
      {pending?.kind === "mode" && (
        <ConfirmDialog
          title={`Make ${name} ${modeLabels[pending.mode]}?`}
          confirm={`Make ${modeLabels[pending.mode]}`}
          busy={busy}
          error={setMode.error?.message}
          onConfirm={() => setMode.mutate({ path, name, mode: pending.mode, discardEdits })}
          onClose={reset}
        >
          <PlanSummary input={{ path, name, mode: pending.mode, discardEdits }} />
        </ConfirmDialog>
      )}
      {pending?.kind === "take" && (
        <ConfirmDialog
          title="Take the Library version?"
          confirm="Discard edit and update"
          busy={busy}
          error={update.error?.message}
          onConfirm={() => update.mutate({ path, name, discardEdits: true })}
          onClose={reset}
        >
          {modified.length > 0 ? (
            <p>
              The edit made in the repo ({modified.map((delivery) => delivery.file).join(", ")}) is replaced with the
              Library definition. Pull into Library keeps it instead.
            </p>
          ) : (
            <p>
              Your hand edit in {handEdited.map((delivery) => delivery.file).join(", ")} is replaced with the Library
              definition, with its Secrets filled in.
            </p>
          )}
          <PlanSummary input={{ path, name, update: true, discardEdits: true }} />
        </ConfirmDialog>
      )}
      {pending?.kind === "trust" && (
        <ConfirmDialog
          title="Trust this Project in Codex?"
          confirm="Trust in Codex"
          busy={busy}
          error={trust.error?.message}
          onConfirm={() => trust.mutate({ path })}
          onClose={reset}
        >
          <p>
            Codex then loads this Project's whole <span className="font-mono">.codex/config.toml</span>, not just this
            MCP Server. Dark Matter writes <span className="font-mono">trust_level = "trusted"</span> for it in{" "}
            <span className="font-mono">~/.codex/config.toml</span>.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** + Add MCP Servers: Library MCP Servers, added as Personal (default) or Shared for the Project's Agents. */
function AddMcpServersDialog({ path, added, onClose }: { path: string; added: string[]; onClose: () => void }) {
  const trpc = useTRPC();
  const library = useQuery(trpc.mcp.list.queryOptions());
  const targets = useQuery(trpc.project.mcpTargets.queryOptions({ path }));
  const current = useQuery(trpc.project.mcpServers.queryOptions({ path }));
  const [picked, setPicked] = useState<string[]>([]);
  const [mode, setMode] = useState<McpDeliveryMode>("personal");
  /**
   * Cursor, OpenCode and Codex keep Personal and Shared in the same Project file, and a
   * committed file can't hold Personal entries (McpFileShared): say so before Add fails.
   */
  const mixed = (targets.data ?? []).flatMap((target) => {
    if (target.file !== target.shared) return [];
    const other = (current.data ?? []).find(
      (server) =>
        server.mode !== mode &&
        server.deliveries.some((delivery) => delivery.agent === target.agent && delivery.file === target.file),
    );
    return other ? [{ target, other }] : [];
  });
  const [reviewing, setReviewing] = useState(false);
  const add = useMutation(trpc.project.addMcpServers.mutationOptions({ onSuccess: onClose }));
  const candidates = (library.data?.servers ?? []).filter(
    (server) => server.definition && !added.includes(server.name),
  );
  const submit = () => add.mutate({ servers: picked.map((name) => ({ path, name, mode })) });
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(36rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-heading">Add MCP Servers</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-body">
            {mode === "personal"
              ? "Personal: written only where you see it, with its Secrets filled in, and never committed."
              : "Shared: written into the Project's committed config, with env-var references only, so teammates get it without Dark Matter."}
          </Dialog.Description>
          <div role="radiogroup" aria-label="Delivery" className="flex gap-2">
            {(["personal", "shared"] as const).map((option) => (
              <label key={option} className="flex cursor-pointer items-center gap-1.5 text-body">
                <input
                  type="radio"
                  name="mcp-mode"
                  className="accent-primary"
                  checked={mode === option}
                  onChange={() => {
                    setMode(option);
                    setReviewing(false);
                  }}
                />
                {modeLabels[option]}
              </label>
            ))}
          </div>
          {(targets.data ?? []).length > 0 && (
            <ul className="flex flex-col gap-1 text-meta">
              {(targets.data ?? []).map((target) => (
                <li key={target.agent} data-testid="mcp-target" className="font-mono text-muted-foreground">
                  {agentName(target.agent)} → {mode === "shared" ? target.shared : target.file}
                  {mode === "personal" && !target.personal && " (tracked by git: Personal isn't offered)"}
                </li>
              ))}
            </ul>
          )}
          {mixed.length > 0 && (
            <div data-testid="mcp-mixed-file">
              <Warning>
                {mixed.map(({ target, other }) => (
                  <p key={target.agent}>
                    {agentName(target.agent)} keeps Personal and Shared MCP Servers in one file,{" "}
                    <span className="font-mono">{target.file}</span>, and it already holds {other.name} as{" "}
                    {modeLabels[other.mode]}. A Project can't mix them there: a Personal entry would be committed, or a
                    Shared one excluded from git. Make {other.name} {modeLabels[mode]} first, or add these as{" "}
                    {modeLabels[other.mode]}.
                  </p>
                ))}
              </Warning>
            </div>
          )}
          {reviewing ? (
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
              {picked.map((name) => (
                <div key={name} className="flex flex-col gap-1.5">
                  <span className="font-medium text-body">{name}</span>
                  <PlanSummary input={{ path, name, mode }} />
                </div>
              ))}
            </div>
          ) : candidates.length === 0 ? (
            <p className="text-muted-foreground text-body">Every Library MCP Server is already in this Project.</p>
          ) : (
            <div className="min-h-0 divide-y overflow-y-auto rounded-xl border">
              {candidates.map((server) => (
                <label
                  key={server.name}
                  data-testid="add-mcp-option"
                  className="flex cursor-pointer items-center gap-3 px-4 py-2.5"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={picked.includes(server.name)}
                    onChange={() =>
                      setPicked((current) =>
                        current.includes(server.name)
                          ? current.filter((name) => name !== server.name)
                          : [...current, server.name],
                      )
                    }
                  />
                  <span className="text-body">{server.name}</span>
                  {mode === "personal" && server.missingSecrets.length > 0 && (
                    <span className="text-status-warning text-meta">
                      {plural(server.missingSecrets.length, "Secret")} to enter first
                    </span>
                  )}
                  <Chip mono className="ml-auto">
                    {server.definition?.transport}
                  </Chip>
                </label>
              ))}
            </div>
          )}
          {add.error && <p className="text-body text-status-warning">{add.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
            {mode === "shared" && !reviewing ? (
              <Button disabled={picked.length === 0} onClick={() => setReviewing(true)}>
                Review {plural(picked.length, "MCP Server")}
              </Button>
            ) : (
              <Button disabled={picked.length === 0 || add.isPending} onClick={submit}>
                Add {plural(picked.length, "MCP Server")}
              </Button>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * MCP entries in the Project Dark Matter didn't write: Vendored (read-only) and
 * untracked, which the user ticks to Adopt as Personal (nothing pre-selected,
 * ADR-0007). Ones that can't be adopted are read-only, with the reason.
 */
function RepoMcpServers({ path }: { path: string }) {
  const trpc = useTRPC();
  const found = useQuery(trpc.project.repoMcpServers.queryOptions({ path }));
  const [adopting, setAdopting] = useState<string[] | null>(null);
  const vendored = found.data?.vendored ?? [];
  const untracked = found.data?.untracked ?? [];
  const ticked = useTicked(untracked.filter((entry) => entry.adoptable).map((entry) => entry.id));
  if (vendored.length === 0 && untracked.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {untracked.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-xl border px-5 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-body">
              {plural(untracked.length, "MCP Server")} in this Project's own config, not from the Library
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={ticked.ids.length === 0}
              onClick={() => setAdopting(ticked.ids)}
            >
              {adoptTickedLabel(ticked.ids.length)} as Personal
            </Button>
          </div>
          {untracked.map((entry) => (
            <div key={entry.id} data-testid="repo-mcp-untracked" className="flex items-start gap-2">
              <span className="pt-px">
                <TickBox
                  name={entry.name}
                  adoptable={entry.adoptable}
                  checked={ticked.has(entry.id)}
                  onChange={(on) => ticked.toggle(entry.id, on)}
                />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-mono text-muted-foreground text-meta">
                  {entry.name} · {agentName(entry.agent)} {entry.file} · {definitionSummary(entry.definition)}
                </span>
                {entry.notAdoptableReason && (
                  <ReadOnlyReason reason={entry.notAdoptableReason} owner={entry.owningAgent} />
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {vendored.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-xl border px-5 py-3">
          <span className="flex items-center gap-2 text-body">
            <Users className="size-3.5 text-muted-foreground" />
            Vendored: committed by the team, left alone
          </span>
          {vendored.map((entry) => (
            <div
              key={entry.id}
              data-testid="repo-mcp-vendored"
              className="truncate font-mono text-muted-foreground text-meta"
            >
              {entry.name} · {agentName(entry.agent)} {entry.file} · {definitionSummary(entry.definition)}
            </div>
          ))}
        </div>
      )}
      <McpAdoptDialog findings={adopting} onClose={() => setAdopting(null)} onAdopted={ticked.clear} />
    </div>
  );
}

/** The Project page's MCP Servers: Personal and Shared deliveries per Agent, On/Off, Remove and approvals. */
export function ProjectMcpServers({ path }: { path: string }) {
  const trpc = useTRPC();
  const servers = useQuery(trpc.project.mcpServers.queryOptions({ path }));
  const [adding, setAdding] = useState(false);
  const list = servers.data ?? [];
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold text-section">
          MCP Servers
          <span className="font-normal text-muted-foreground text-meta tabular-nums">{list.length}</span>
        </h2>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus />
          Add MCP Servers
        </Button>
      </div>
      {servers.error && <p className="text-status-warning text-meta">{servers.error.message}</p>}
      {list.length === 0 ? (
        <p className="text-muted-foreground text-body">No Project MCP Servers yet. Add them from the Library.</p>
      ) : (
        <div className="divide-y rounded-xl border">
          {list.map((server) => (
            <ProjectMcpServerRow key={server.name} path={path} server={server} />
          ))}
        </div>
      )}
      <RepoMcpServers path={path} />
      {adding && (
        <AddMcpServersDialog path={path} added={list.map((server) => server.name)} onClose={() => setAdding(false)} />
      )}
    </section>
  );
}
