import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";

const pill = "rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground";

/**
 * What the repo already has (#28): `skills-lock.json` entries waiting to be
 * fulfilled from the Library, and Vendored Skills (committed, not Dark
 * Matter's), shown read-only.
 */
export function RepoSkills({ path }: { path: string }) {
  const trpc = useTRPC();
  const repo = useQuery(trpc.project.repoSkills.queryOptions({ path }));
  const fulfil = useMutation(trpc.project.fulfilLock.mutationOptions());
  const locked = repo.data?.locked ?? [];
  const vendored = repo.data?.vendored ?? [];
  const ready = locked.filter((entry) => entry.message === null).map((entry) => entry.name);
  if (repo.error) return <p className="text-sm text-status-warning">{repo.error.message}</p>;
  return (
    <>
      {locked.length > 0 && (
        <section data-testid="locked-skills" className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold text-sm">
              In skills-lock.json
              <span className="font-normal text-muted-foreground text-xs tabular-nums">{locked.length}</span>
            </h2>
            <Button
              size="sm"
              disabled={ready.length === 0 || fulfil.isPending}
              onClick={() => fulfil.mutate({ path, names: ready })}
            >
              Fulfil from Library
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            This repo's skills-lock.json wants these Skills. Fulfilling makes each one a Copy of its Library Skill;
            files already committed are kept as they are.
          </p>
          {fulfil.error && <p className="text-sm text-status-warning">{fulfil.error.message}</p>}
          <div className="divide-y rounded-xl border">
            {locked.map((entry) => (
              <div key={entry.name} data-testid="locked-skill" className="flex items-center gap-3 px-5 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-sm">{entry.name}</span>
                    <span className={pill}>{entry.source}</span>
                    {!entry.present && <span className={pill}>not in repo</span>}
                  </div>
                  <p className="truncate text-muted-foreground text-xs">
                    {entry.message ?? (entry.key ? `from Library ${entry.key}` : "Imported first, then copied")}
                  </p>
                </div>
                {entry.message === null && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={fulfil.isPending}
                    onClick={() => fulfil.mutate({ path, names: [entry.name] })}
                  >
                    Fulfil
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {vendored.length > 0 && (
        <section data-testid="vendored-skills" className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 font-semibold text-sm">
            Vendored Skills
            <span className="font-normal text-muted-foreground text-xs tabular-nums">{vendored.length}</span>
          </h2>
          <p className="text-muted-foreground text-xs">
            Committed in this repo, not by Dark Matter. Shown here, never changed.
          </p>
          <div className="divide-y rounded-xl border">
            {vendored.map((skill) => (
              <div key={skill.paths.join()} data-testid="vendored-skill" className="flex flex-col gap-0.5 px-5 py-3">
                <span className="font-medium text-sm">{skill.name}</span>
                {skill.description && <p className="truncate text-muted-foreground text-xs">{skill.description}</p>}
                <div className="truncate font-mono text-muted-foreground text-xs">{skill.paths.join(" · ")}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
