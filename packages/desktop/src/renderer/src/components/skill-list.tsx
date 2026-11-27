import type { LibrarySkill } from "@dark-matter/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { StarSkillButton } from "./favourites";
import { ModifiedBadge } from "./modified-badge";
import { RowText } from "./row-text";
import { OrphanedBadge } from "./updates";

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Library Skills grouped by Namespace, `local` last. */
export const byNamespace = (skills: LibrarySkill[]) => {
  const groups = new Map<string, LibrarySkill[]>();
  for (const skill of skills) groups.set(skill.namespace, [...(groups.get(skill.namespace) ?? []), skill]);
  return [...groups.entries()].sort(([a], [b]) => (a === "local" ? 1 : b === "local" ? -1 : a.localeCompare(b)));
};

function SkillRow({ skill }: { skill: LibrarySkill }) {
  return (
    <div className="flex items-center hover:bg-muted/50">
      <StarSkillButton skillKey={skill.key} className="ml-3.5" />
      <Link
        to="/skill"
        search={{ key: skill.key }}
        data-testid="library-skill"
        className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2.5 pr-5 pl-2"
      >
        <RowText
          title={skill.name}
          chips={
            <>
              {skill.localSource && <Chip mono>Local Source</Chip>}
              {skill.modified && <ModifiedBadge />}
              {skill.orphaned && <OrphanedBadge />}
              {skill.nameConflict && (
                <Chip tone="warning" data-testid="name-conflict">
                  Name Conflict
                </Chip>
              )}
            </>
          }
          description={skill.description}
          detail={[skill.key, skill.localSource].filter(Boolean).join(" · ")}
        />
        <span data-testid="project-count" className="shrink-0 text-muted-foreground text-meta tabular-nums">
          {plural(skill.projects, "Project")}
        </span>
        <ChevronRight className="size-4 text-muted-foreground" />
      </Link>
    </div>
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
