import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PageHead } from "@/components/page-head";
import { RenameNamespaceDialog } from "@/components/rename-namespace-dialog";
import { plural, SkillRows } from "@/components/skill-list";
import { Button } from "@/components/ui/button";
import { tildify } from "@/lib/paths";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/namespace")({
  validateSearch: (search: Record<string, unknown>): { name: string } => ({
    name: typeof search.name === "string" ? search.name : "",
  }),
  component: NamespaceView,
});

/** One Namespace's Skills, with Rename Namespace. */
function NamespaceView() {
  const { name } = Route.useSearch();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const library = useQuery(trpc.library.list.queryOptions());
  const info = useQuery(trpc.core.info.queryOptions());
  const [renaming, setRenaming] = useState(false);
  const skills = (library.data?.skills ?? []).filter((skill) => skill.namespace === name);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <PageHead
            title={name}
            summary={plural(skills.length, "Skill")}
            {...(info.data && { status: `${tildify(info.data.libraryHome)}/skills/${name}/` })}
          />
        </div>
        <Button size="sm" variant="outline" disabled={skills.length === 0} onClick={() => setRenaming(true)}>
          Rename Namespace
        </Button>
      </div>
      {library.isPending ? null : skills.length === 0 ? (
        <p data-testid="namespace-empty" className="text-muted-foreground text-sm">
          No Library Skills in this Namespace.
        </p>
      ) : (
        <SkillRows skills={skills} />
      )}
      <RenameNamespaceDialog
        from={name}
        open={renaming}
        onClose={() => setRenaming(false)}
        onRenamed={(to) => {
          setRenaming(false);
          void navigate({ to: "/namespace", search: { name: to }, replace: true });
        }}
      />
    </div>
  );
}
