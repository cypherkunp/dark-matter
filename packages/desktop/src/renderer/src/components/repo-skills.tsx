import { useMutation, useQuery } from "@tanstack/react-query";
import { openList, openRow } from "@/components/list";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

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
  if (repo.error) return <p className="text-body text-status-warning">{repo.error.message}</p>;
  return (
    <>
      {locked.length > 0 && (
        <section data-testid="locked-skills" className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold text-section">
              In skills-lock.json
              <span className="font-normal text-muted-foreground text-meta tabular-nums">{locked.length}</span>
            </h2>
            <Button
              size="sm"
              disabled={ready.length === 0 || fulfil.isPending}
              onClick={() => fulfil.mutate({ path, names: ready })}
            >
              Fulfil from Library
            </Button>
          </div>
          <p className="text-muted-foreground text-meta">
            This repo's skills-lock.json wants these Skills. Fulfilling makes each one a Copy of its Library Skill;
            files already committed are kept as they are.
          </p>
          {fulfil.error && <p className="text-body text-status-warning">{fulfil.error.message}</p>}
          <div className={openList}>
            {locked.map((entry) => (
              <div key={entry.name} data-testid="locked-skill" className={cn("flex items-center gap-3 py-3", openRow)}>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-body">{entry.name}</span>
                    <Chip mono>{entry.source}</Chip>
                    {!entry.present && <Chip mono>not in repo</Chip>}
                  </div>
                  <p className="truncate text-muted-foreground text-meta">
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
          <h2 className="flex items-center gap-2 font-semibold text-section">
            Vendored Skills
            <span className="font-normal text-muted-foreground text-meta tabular-nums">{vendored.length}</span>
          </h2>
          <p className="text-muted-foreground text-meta">
            Committed in this repo, not by Dark Matter. Shown here, never changed.
          </p>
          <div className={openList}>
            {vendored.map((skill) => (
              <div
                key={skill.paths.join()}
                data-testid="vendored-skill"
                className={cn("flex flex-col gap-0.5 py-3", openRow)}
              >
                <span className="font-medium text-body">{skill.name}</span>
                {skill.description && <p className="truncate text-muted-foreground text-meta">{skill.description}</p>}
                <div className="truncate font-mono text-muted-foreground text-meta">{skill.paths.join(" · ")}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
