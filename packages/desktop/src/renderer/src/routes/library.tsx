import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Library } from "lucide-react";
import { Overview } from "@/components/overview";
import { Page } from "@/components/page";
import { PageHead } from "@/components/page-head";
import { byNamespace, plural, SkillRows } from "@/components/skill-list";
import { tildify } from "@/lib/paths";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/library")({ component: AllSkills });

function AllSkills() {
  const trpc = useTRPC();
  const library = useQuery(trpc.library.list.queryOptions());
  const info = useQuery(trpc.core.info.queryOptions());
  const skills = library.data?.skills ?? [];
  const namespaces = new Set(skills.map((skill) => skill.namespace)).size;

  return (
    <Page>
      <PageHead
        title="All Skills"
        summary={`${plural(skills.length, "Skill")} · ${plural(namespaces, "Namespace")}`}
        {...(info.data && { status: `Library at ${tildify(info.data.libraryHome)}` })}
      />
      <Overview />
      {library.isPending ? null : skills.length === 0 ? (
        <section
          data-testid="library-empty"
          className="flex flex-col items-center gap-3 rounded-2xl bg-foreground/[0.025] px-6 py-16 text-center"
        >
          <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Library className="size-5" />
          </div>
          <h2 className="font-semibold text-heading">Your Library is empty</h2>
          <p className="max-w-sm text-muted-foreground text-body">
            A Scan finds the Skills your Agents can see. Adopt them to bring them into the Library, or import Skills
            from GitHub.
          </p>
        </section>
      ) : (
        byNamespace(skills).map(([namespace, members]) => (
          <section key={namespace} data-testid="library-namespace" className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 font-semibold text-section">
              <Link to="/namespace" search={{ name: namespace }} className="font-mono hover:underline">
                {namespace}
              </Link>
              <span className="font-normal text-muted-foreground text-meta tabular-nums">{members.length}</span>
            </h2>
            <SkillRows skills={members} />
          </section>
        ))
      )}
    </Page>
  );
}
