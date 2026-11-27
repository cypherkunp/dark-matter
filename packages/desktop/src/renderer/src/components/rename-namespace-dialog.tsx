import { Dialog } from "@base-ui/react/dialog";
import { NamespaceName } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { stepText } from "@/components/adopt-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/lib/trpc";

/**
 * Rename Namespace: type the new name, review the plan (folder moves, the
 * Library Lock edit, Links to re-create), then apply it.
 */
export function RenameNamespaceDialog({
  from,
  open,
  onClose,
  onRenamed,
}: {
  from: string;
  open: boolean;
  onClose: () => void;
  onRenamed: (to: string) => void;
}) {
  const trpc = useTRPC();
  const [to, setTo] = useState("");
  const valid = NamespaceName.safeParse(to).success && to !== from;
  const plan = useQuery({
    ...trpc.namespace.plan.queryOptions({ from, to }),
    enabled: open && valid,
    staleTime: 0,
    gcTime: 0,
  });
  const rename = useMutation(
    trpc.namespace.rename.mutationOptions({
      onSuccess: (done) => onRenamed(done.to),
      onError: () => void plan.refetch(),
    }),
  );
  const error = (valid && plan.error) || rename.error;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          rename.reset();
          setTo("");
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(36rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-heading">Rename Namespace</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-body">
            Moves every Skill in <span className="font-mono">{from}</span> to the new Namespace and re-creates any Links
            to them.
          </Dialog.Description>
          <Input
            aria-label="New Namespace"
            className="font-mono"
            placeholder="owner/repo or local"
            value={to}
            onChange={(event) => setTo(event.target.value.trim())}
          />
          {to !== "" && !valid && (
            <p className="text-muted-foreground text-meta">A Namespace is local or owner/repo, and must differ.</p>
          )}
          {valid && plan.data && (
            <ol className="flex flex-col gap-1 overflow-y-auto font-mono text-micro text-muted-foreground">
              {plan.data.steps.map((step) => (
                <li key={stepText(step)}>{stepText(step)}</li>
              ))}
            </ol>
          )}
          {error && <p className="text-body text-status-warning">{error.message}</p>}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
            <Button
              disabled={!valid || !plan.data || rename.isPending}
              onClick={() => {
                if (plan.data) rename.mutate({ from, to, planId: plan.data.planId });
              }}
            >
              {rename.isPending ? "Renaming…" : "Rename"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
