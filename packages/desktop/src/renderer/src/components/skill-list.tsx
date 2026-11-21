import type { LibrarySkill } from "@dark-matter/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Library Skills grouped by Namespace, `local` last. */
export const byNamespace = (skills: LibrarySkill[]) => {
  const groups = new Map<string, LibrarySkill[]>();
  for (const skill of skills) groups.set(skill.namespace, [...(groups.get(skill.namespace) ?? []), skill]);
  return [...groups.entries()].sort(([a], [b]) => (a === "local" ? 1 : b === "local" ? -1 : a.localeCompare(b)));
};

function SkillRow({ skill }: { skill: LibrarySkill }) {
  return (
    <Link
      to="/skill"
      search={{ key: skill.key }}
      data-testid="library-skill"
      className="flex min-h-16 items-center gap-3 px-5 py-3 hover:bg-muted/50"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{skill.name}</span>
          {skill.localSource && (
            <span className="rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              Local Source
            </span>
          )}
          {skill.modified && (
            <span
              data-testid="skill-modified"
              title="Changed since it was last Imported from its Source"
              className="rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              Modified
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
      </div>
      <span data-testid="project-count" className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {plural(skill.projects, "Project")}
      </span>
      <ChevronRight className="size-4 text-muted-foreground" />
    </Link>
  );
}

/** A bordered card of Skill rows; each opens its Skill page. */
export function SkillRows({ skills }: { skills: LibrarySkill[] }) {
  return (
    <div className="divide-y overflow-hidden rounded-xl border">
      {skills.map((skill) => (
        <SkillRow key={skill.key} skill={skill} />
      ))}
    </div>
  );
}
