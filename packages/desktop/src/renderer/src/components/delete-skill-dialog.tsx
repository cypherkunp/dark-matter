import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";

/**
 * Delete a Library Skill (#34): it moves to `trash/` for the configured days.
 * Its Links are removed from every Project first; Copies stay in their repos (review #5).
 */
export function DeleteSkillDialog({
  skillKey,
  open,
  onClose,
  onDeleted,
}: {
  skillKey: string;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const trpc = useTRPC();
  const plan = useQuery({
    ...trpc.skill.deletePlan.queryOptions({ key: skillKey }),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const remove = useMutation(trpc.skill.delete.mutationOptions({ onSuccess: onDeleted }));
  const projects = plan.data?.projects ?? [];
  const links = projects.filter((project) => project.mode === "link");
  const copies = projects.filter((project) => project.mode !== "link");

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          remove.reset();
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(32rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-heading">Delete Skill</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-body">
            <span className="font-mono">{skillKey}</span> moves to <span className="font-mono">trash/</span> and is
            purged after {plan.data?.retentionDays ?? "…"} days.
          </Dialog.Description>
          {projects.length > 0 && (
            <ul
              data-testid="delete-warnings"
              className="flex flex-col gap-1.5 rounded-lg border border-warning-border bg-warning-surface px-4 py-3 text-body"
            >
              {links.length > 0 && (
                <li className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
                  <span>Its Links are removed from {links.map((project) => project.projectName).join(", ")}.</span>
                </li>
              )}
              {copies.length > 0 && (
                <li className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
                  <span>
                    Copies stay committed in {copies.map((project) => project.projectName).join(", ")} (Vendored from
                    then on).
                  </span>
                </li>
              )}
            </ul>
          )}
          {(plan.error || remove.error) && (
            <p className="text-body text-status-warning">{(plan.error ?? remove.error)?.message}</p>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
            <Button
              variant="destructive"
              disabled={!plan.data || remove.isPending}
              onClick={() => remove.mutate({ key: skillKey })}
            >
              {remove.isPending ? "Deleting…" : "Move to trash"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
