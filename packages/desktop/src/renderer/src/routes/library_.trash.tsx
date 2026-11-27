import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { PageHead } from "@/components/page-head";
import { plural } from "@/components/skill-list";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/library_/trash")({ component: TrashView });

const day = (iso: string) => new Date(iso).toLocaleDateString();

/** Deleted Library Skills waiting to be purged, each with Restore (story 44). */
function TrashView() {
  const trpc = useTRPC();
  const trash = useQuery(trpc.trash.list.queryOptions());
  const restore = useMutation(trpc.trash.restore.mutationOptions());
  const list = trash.data ?? [];
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <PageHead
        title="Trash"
        summary={plural(list.length, "deleted Skill")}
        status="Deleted Skills are purged by the daily run after the retention set in Settings."
      />
      {restore.error && <p className="text-sm text-status-warning">{restore.error.message}</p>}
      {trash.isPending ? null : list.length === 0 ? (
        <section
          data-testid="trash-empty"
          className="flex flex-col items-center gap-3 rounded-xl border px-6 py-16 text-center"
        >
          <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Trash2 className="size-5" />
          </div>
          <h2 className="font-semibold text-base">The trash is empty</h2>
        </section>
      ) : (
        <div className="divide-y rounded-xl border">
          {list.map((skill) => (
            <div key={skill.id} data-testid="trashed-skill" className="flex min-h-16 items-center gap-3 px-5 py-3">
              <StatusDot tone="off" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-sm">{skill.name}</span>
                <span className="truncate font-mono text-muted-foreground text-xs">
                  {skill.key} · deleted {day(skill.deletedAt)} · purged {day(skill.purgeAt)}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={restore.isPending}
                onClick={() => restore.mutate({ id: skill.id })}
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        Restore puts the Skill back in the Library. Add it to Projects again from its{" "}
        <Link to="/library" className="underline">
          Library
        </Link>{" "}
        page.
      </p>
    </div>
  );
}
