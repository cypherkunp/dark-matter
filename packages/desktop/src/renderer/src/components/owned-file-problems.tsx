import { useMutation, useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";

/**
 * The amber alerts panel for owned files holding an invalid hand edit
 * (ADR-0005). The core keeps the last good state and won't write the file
 * until the edit is fixed by hand or discarded here.
 */
export function OwnedFileProblems() {
  const trpc = useTRPC();
  const problems = useQuery(trpc.ownedFiles.problems.queryOptions());
  const discard = useMutation(trpc.ownedFiles.discard.mutationOptions());
  if (!problems.data?.length) return null;

  return (
    <section className="flex flex-col divide-y divide-warning-border rounded-xl border border-warning-border bg-warning-surface">
      {problems.data.map((problem) => (
        <div
          key={problem.file}
          data-testid="owned-file-problem"
          role="alert"
          className="flex items-start gap-3 px-5 py-4"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-sm">
              <span className="font-mono font-semibold">{problem.file}</span> has a hand edit that isn't valid
            </p>
            <p className="break-words font-mono text-muted-foreground text-xs">{problem.message}</p>
            <p className="text-muted-foreground text-xs">
              Dark Matter keeps using the last good state and won't overwrite your edit until you fix it or discard it.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={discard.isPending}
            onClick={() => discard.mutate({ file: problem.file })}
          >
            Discard my edit
          </Button>
        </div>
      ))}
    </section>
  );
}
