import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { Page } from "@/components/page";
import { PageHead } from "@/components/page-head";
import { RowText } from "@/components/row-text";
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
    <Page>
      <PageHead
        title="Trash"
        summary={plural(list.length, "deleted Skill")}
        status="Deleted Skills are purged by the daily run after the retention set in Settings."
      />
      {restore.error && <p className="text-body text-status-warning">{restore.error.message}</p>}
      {trash.isPending ? null : list.length === 0 ? (
        <section
          data-testid="trash-empty"
          className="flex flex-col items-center gap-3 rounded-xl border px-6 py-16 text-center"
        >
          <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Trash2 className="size-5" />
          </div>
          <h2 className="font-semibold text-heading">The trash is empty</h2>
        </section>
      ) : (
        <div className="divide-y rounded-xl border">
          {list.map((skill) => (
            <div key={skill.id} data-testid="trashed-skill" className="flex min-h-14 items-center gap-3 px-5 py-2.5">
              <StatusDot tone="off" />
              <RowText
                title={skill.name}
                detail={`${skill.key} · deleted ${day(skill.deletedAt)} · purged ${day(skill.purgeAt)}`}
              />
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
      <p className="text-muted-foreground text-meta">
        Restore puts the Skill back in the Library. Add it to Projects again from its{" "}
        <Link to="/library" className="underline">
          Library
        </Link>{" "}
        page.
      </p>
    </Page>
  );
}
