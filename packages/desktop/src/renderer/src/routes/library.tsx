import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Library } from "lucide-react";
import { PageHead } from "@/components/page-head";
import { tildify } from "@/lib/paths";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/library")({ component: AllSkills });

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

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
        {...(info.data && { status: `Library at ${tildify(info.data.home)}` })}
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
        <section className="divide-y rounded-xl border">
          {skills.map((skill) => (
            <div key={skill.key} className="flex min-h-16 flex-col justify-center gap-0.5 px-5 py-3">
              <div className="font-medium">{skill.name}</div>
              <div className="font-mono text-muted-foreground text-xs">{skill.namespace}</div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
