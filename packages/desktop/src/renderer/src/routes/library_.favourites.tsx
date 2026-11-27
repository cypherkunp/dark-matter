import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, Star } from "lucide-react";
import { StarSourceButton } from "@/components/favourites";
import { PageHead } from "@/components/page-head";
import { plural, SkillRows } from "@/components/skill-list";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/library_/favourites")({ component: FavouritesView });

/** Favourites (#35): starred Skills plus every Library Skill from a starred Source. */
function FavouritesView() {
  const trpc = useTRPC();
  const view = useQuery(trpc.favourites.view.queryOptions());
  const skills = view.data?.skills ?? [];
  const sources = view.data?.sources ?? [];
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <PageHead
        title="Favourites"
        summary={`${plural(skills.length, "Skill")} · ${plural(sources.length, "starred Source")}`}
        status="A starred Source tells you in the Inbox when it gains Skills. Nothing is Imported on its own."
      />
      {view.isPending ? null : skills.length === 0 && sources.length === 0 ? (
        <section
          data-testid="favourites-empty"
          className="flex flex-col items-center gap-3 rounded-xl border px-6 py-16 text-center"
        >
          <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Star className="size-5" />
          </div>
          <h2 className="font-semibold text-heading">Nothing starred yet</h2>
          <p className="max-w-sm text-muted-foreground text-body">
            Star a Skill from its row or page, or a Source from its Namespace or the GitHub import screen.
          </p>
        </section>
      ) : (
        <>
          {sources.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="flex items-center gap-2 font-semibold text-section">
                Starred Sources
                <span className="font-normal text-muted-foreground text-meta tabular-nums">{sources.length}</span>
              </h2>
              <div className="divide-y rounded-xl border">
                {sources.map((source) => (
                  <div
                    key={source.source}
                    data-testid="favourite-source-row"
                    className="flex min-h-14 items-center gap-3 px-5 py-2.5"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <Link
                        to="/namespace"
                        search={{ name: source.source }}
                        className="font-medium font-mono text-body hover:underline"
                      >
                        {source.source}
                      </Link>
                      <span className="text-muted-foreground text-meta">
                        {plural(source.skills, "Library Skill")}
                        {source.checkedAt
                          ? ` · checked ${new Date(source.checkedAt).toLocaleString()}`
                          : " · not checked yet"}
                      </span>
                    </div>
                    {source.newSkills > 0 && (
                      <Link
                        to="/inbox"
                        className="flex items-center gap-1 rounded-full border border-warning-border bg-warning-surface px-2 py-0.5 text-micro text-status-warning"
                      >
                        {plural(source.newSkills, "new Skill")}
                        <ChevronRight className="size-3" />
                      </Link>
                    )}
                    <StarSourceButton source={source.source} />
                  </div>
                ))}
              </div>
            </section>
          )}
          {skills.length > 0 && <SkillRows skills={skills} />}
        </>
      )}
    </div>
  );
}
