import { Dialog } from "@base-ui/react/dialog";
import type { McpAdoptOutcome, McpAdoptPlanServer } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { ConsentError } from "@/components/adopt-consent";
import { stepText } from "@/components/adopt-dialog";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const outcomeLabels: Record<McpAdoptOutcome, string> = {
  moved: "move",
  merged: "identical, merged",
  variant: "variant, kept side by side",
};

function PlannedServer({
  server,
  name,
  onName,
}: {
  server: McpAdoptPlanServer;
  name: string | undefined;
  onName: (name: string) => void;
}) {
  return (
    <div data-testid="mcp-plan-server" className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-body">{server.name}</span>
        <span className="text-muted-foreground text-meta">from {agentName(server.agent)}</span>
        <Chip tone={server.outcome === "variant" ? "warning" : "neutral"}>{outcomeLabels[server.outcome]}</Chip>
      </div>
      {server.outcome === "variant" && (
        <div className="flex items-center gap-2 text-meta">
          <span className="text-muted-foreground">Name it</span>
          <Input
            aria-label={`Library name for ${server.name} from ${agentName(server.agent)}`}
            className="h-7 w-56 font-mono text-meta"
            defaultValue={name ?? server.libraryName}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim();
              if (next && next !== server.libraryName) onName(next);
            }}
          />
        </div>
      )}
      {server.outcome !== "variant" && (
        <span className="font-mono text-micro text-muted-foreground">→ {server.libraryName}</span>
      )}
      {server.secrets.length > 0 && (
        <span className="text-muted-foreground text-meta">
          Moves {plural(server.secrets.length, "Secret")} into the keychain: {server.secrets.join(", ")}
        </span>
      )}
      {server.diff && (
        <details className="text-meta">
          <summary className="cursor-default text-muted-foreground">Differs from {server.diff.against}</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-micro leading-relaxed">
            {server.diff.patch}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * The dry run for Adopting Global MCP Servers, and the confirmation that
 * applies it. Variants get a name you can change before applying.
 */
export function McpAdoptDialog({
  findings,
  onClose,
  onAdopted,
}: {
  findings: string[] | null;
  onClose: () => void;
  /** After the Adopt is applied, e.g. to clear what was ticked. */
  onAdopted?: () => void;
}) {
  const trpc = useTRPC();
  const open = findings !== null && findings.length > 0;
  const [names, setNames] = useState<Record<string, string>>({});
  const input = { findings: findings ?? [], ...(Object.keys(names).length > 0 && { names }) };
  const plan = useQuery({
    ...trpc.mcp.adoptPlan.queryOptions(input),
    enabled: open,
    // Keeps the plan (and the name fields) on screen while a renamed plan loads or is refused.
    placeholderData: (previous) => previous,
    staleTime: 0,
    gcTime: 0,
  });
  const close = () => {
    setNames({});
    onClose();
  };
  const execute = useMutation(
    trpc.mcp.adoptExecute.mutationOptions({
      onSuccess: () => {
        close();
        onAdopted?.();
      },
      onError: () => void plan.refetch(),
    }),
  );
  const error = plan.error ?? execute.error;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          execute.reset();
          close();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(42rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-heading">
            Adopt {plural(findings?.length ?? 0, "MCP Server")}
          </Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-body">
            Each definition moves into the Library and inline secrets move into the keychain. The global entry is
            removed with a targeted edit; Undo Adopt puts it back.
          </Dialog.Description>
          {plan.data && (
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
              {plan.data.warnings.map((warning) => (
                <div
                  key={warning}
                  className="flex gap-2.5 rounded-xl border border-warning-border bg-warning-surface px-4 py-3 text-body"
                >
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" />
                  <span>{warning}</span>
                </div>
              ))}
              <div className="divide-y rounded-xl border">
                {plan.data.servers.map((server) => (
                  <PlannedServer
                    key={server.finding}
                    server={server}
                    name={names[server.finding]}
                    onName={(name) => setNames((current) => ({ ...current, [server.finding]: name }))}
                  />
                ))}
              </div>
              <ol className="flex flex-col gap-1 font-mono text-micro text-muted-foreground">
                {plan.data.steps.map((step) => (
                  <li key={stepText(step)}>{stepText(step)}</li>
                ))}
              </ol>
            </div>
          )}
          <ConsentError error={error} />
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
            <Button
              disabled={!plan.data || plan.isFetching || execute.isPending}
              onClick={() => {
                if (plan.data) execute.mutate({ ...input, planId: plan.data.planId });
              }}
            >
              {execute.isPending ? "Adopting…" : "Adopt"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
