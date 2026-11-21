import type { LibrarySkill } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Library } from "lucide-react";
import { PageHead } from "@/components/page-head";
import { Button } from "@/components/ui/button";
import { tildify } from "@/lib/paths";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/library")({ component: AllSkills });

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function SkillRow({ skill }: { skill: LibrarySkill }) {
  const trpc = useTRPC();
  const undo = useMutation(trpc.adopt.undo.mutationOptions());
  return (
    <div data-testid="library-skill" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{skill.name}</span>
          {skill.localSource && (
            <span className="rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              Local Source
            </span>
          )}
          {skill.nameConflict && (
            <span
              data-testid="name-conflict"
              className="rounded-md border border-warning-border bg-warning-surface px-1.5 py-0.5 text-[11px]"
            >
              Name Conflict
            </span>
          )}
        </div>
        {skill.description && <p className="truncate text-muted-foreground text-xs">{skill.description}</p>}
        <div className="truncate font-mono text-muted-foreground text-xs">
          {[skill.key, skill.localSource].filter(Boolean).join(" · ")}
        </div>
        {undo.error && <p className="text-status-warning text-xs">{undo.error.message}</p>}
      </div>
      <span data-testid="project-count" className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {plural(skill.projects, "Project")}
      </span>
      {skill.adoptedFrom && (
        <Button
          size="sm"
          variant="ghost"
          title={`Move it back to ${skill.adoptedFrom}`}
          disabled={undo.isPending}
          onClick={() => undo.mutate({ key: skill.key })}
        >
          Undo Adopt
        </Button>
      )}
    </div>
  );
}

/** Library Skills grouped by Namespace, `local` last. */
const byNamespace = (skills: LibrarySkill[]) => {
  const groups = new Map<string, LibrarySkill[]>();
  for (const skill of skills) groups.set(skill.namespace, [...(groups.get(skill.namespace) ?? []), skill]);
  return [...groups.entries()].sort(([a], [b]) => (a === "local" ? 1 : b === "local" ? -1 : a.localeCompare(b)));
};

function AllSkills() {
  const trpc = useTRPC();
  const library = useQuery(trpc.library.list.queryOptions());
  const info = useQuery(trpc.core.info.queryOptions());
  const skills = library.data?.skills ?? [];
  const namespaces = new Set(skills.map((skill) => skill.namespace)).size;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <PageHead
        title="All Skills"
        summary={`${plural(skills.length, "Skill")} · ${plural(namespaces, "Namespace")}`}
        {...(info.data && { status: `Library at ${tildify(info.data.libraryHome)}` })}
      />
      {library.isPending ? null : skills.length === 0 ? (
        <section
          data-testid="library-empty"
          className="flex flex-col items-center gap-3 rounded-xl border px-6 py-16 text-center"
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <Library className="size-5 text-muted-foreground" />
          </div>
          <h2 className="font-semibold text-base">Your Library is empty</h2>
          <p className="max-w-sm text-muted-foreground text-sm">
            A Scan finds the Skills your Agents can see. Adopt them to bring them into the Library, or import Skills
            from GitHub.
          </p>
        </section>
      ) : (
        byNamespace(skills).map(([namespace, members]) => (
          <section key={namespace} data-testid="library-namespace" className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 font-semibold text-sm">
              <span className="font-mono">{namespace}</span>
              <span className="font-normal text-muted-foreground text-xs tabular-nums">{members.length}</span>
            </h2>
            <div className="divide-y rounded-xl border">
              {members.map((skill) => (
                <SkillRow key={skill.key} skill={skill} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
