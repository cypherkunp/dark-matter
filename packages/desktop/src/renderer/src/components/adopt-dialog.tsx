import { Dialog } from "@base-ui/react/dialog";
import type { AdoptOutcome, AdoptPlan, AdoptPlanSkill, PlanStep } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { ConsentError } from "@/components/adopt-consent";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { useTRPC } from "@/lib/trpc";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const outcomeLabels: Record<AdoptOutcome, string> = {
  moved: "move",
  merged: "identical copy, merged",
  variant: "variant, kept side by side",
  localSource: "Local Source",
};

export const stepText = (step: PlanStep): string => {
  switch (step.kind) {
    case "move":
      return `move ${step.from} → ${step.to}`;
    case "copy":
      return `copy ${step.from} → ${step.to}`;
    case "createLink":
      return `link ${step.path} → ${step.target}`;
    case "removeLink":
      return `remove symlink ${step.path}`;
    case "removeCopy":
      return `remove identical copy ${step.path}`;
    case "removeFolder":
      return `remove folder ${step.path}`;
    case "editFile":
      return `edit ${step.path}: ${step.change}${step.backup ? ` (backup ${step.backup})` : ""}`;
    case "storeSecret":
      return `store Secret ${step.name} in the keychain`;
    case "deleteSecret":
      return `delete Secret ${step.name} from the keychain`;
  }
};

function PlannedSkill({ skill }: { skill: AdoptPlanSkill }) {
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-body">{skill.name}</span>
        <Chip mono>{skill.key}</Chip>
        <Chip tone={skill.outcome === "variant" ? "warning" : "neutral"}>{outcomeLabels[skill.outcome]}</Chip>
      </div>
      {skill.diff && (
        <details className="text-meta">
          <summary className="cursor-default text-muted-foreground">Differs from {skill.diff.against}</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-micro leading-relaxed">
            {skill.diff.patch}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * The dry run for Adopting some findings, and the confirmation that applies it.
 * Nothing changes on disk until "Adopt" is pressed.
 */
export function AdoptDialog({
  findings,
  onClose,
  onAdopted,
}: {
  findings: string[] | null;
  onClose: () => void;
  /** After the Adopt is applied, e.g. to open the Add to Projects grid. */
  onAdopted?: (plan: AdoptPlan) => void;
}) {
  const trpc = useTRPC();
  const open = findings !== null && findings.length > 0;
  const plan = useQuery({
    ...trpc.adopt.plan.queryOptions({ findings: findings ?? [] }),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const execute = useMutation(
    // A stale plan is refused by the core: show the fresh one to review again.
    trpc.adopt.execute.mutationOptions({
      onSuccess: (applied) => {
        onClose();
        onAdopted?.(applied);
      },
      onError: () => void plan.refetch(),
    }),
  );
  const count = findings?.length ?? 0;
  // Untracked Project Skills go back into their Project as a Link (#29).
  const keepLink = (findings ?? []).every((id) => id.startsWith("untracked-skill:"));
  const error = plan.error ?? execute.error;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          execute.reset();
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(42rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-heading">
            {keepLink ? "Adopt & keep Link" : "Adopt"} {plural(count, "Skill")}
          </Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-body">
            Each Skill moves into the Library{keepLink ? " and a Link to it goes back where it was, On" : ""}. Nothing
            is deleted, and you can Undo Adopt from the Skill's Provenance tab.
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
                {plan.data.skills.map((skill) => (
                  <PlannedSkill key={skill.finding} skill={skill} />
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
              disabled={!plan.data || execute.isPending}
              onClick={() => {
                if (plan.data) execute.mutate({ findings: plan.data.findings, planId: plan.data.planId });
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
