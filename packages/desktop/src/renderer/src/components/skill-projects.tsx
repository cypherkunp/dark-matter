import type { SkillDetail, SkillProjectUse } from "@dark-matter/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CopyActions, CopyStateBadge, useProjectSkillChanges, useResolveConflict } from "@/components/copy-actions";
import { openList, openRow } from "@/components/list";
import { modeLabels, OnOffSwitch } from "@/components/project-skills";
import { RowText } from "@/components/row-text";
import { StatusDot } from "@/components/status-dot";
import { Chip } from "@/components/ui/chip";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

function ProjectUseRow({ use }: { use: SkillProjectUse }) {
  const changes = useProjectSkillChanges(use.path, use);
  const resolve = useResolveConflict(use.path, use);
  const conflict = use.status === "nameConflict";
  return (
    <div data-testid="skill-project-row" className={cn("flex min-h-14 items-center gap-3 py-2.5", openRow)}>
      <StatusDot tone={conflict ? "warning" : use.on ? "on" : "off"} />
      <RowText
        title={
          <Link to="/project" search={{ path: use.path }} className="hover:underline">
            {use.projectName}
          </Link>
        }
        chips={
          <>
            <Chip mono data-testid="delivery-mode">
              {modeLabels[use.mode]}
            </Chip>
            <span className="text-muted-foreground text-meta">
              {conflict ? "Name Conflict" : use.on ? "On" : "Off"}
            </span>
            <CopyStateBadge skill={use} />
          </>
        }
        detail={use.path}
      >
        {(changes.error ?? resolve.error) && (
          <p className="text-status-warning text-meta">{(changes.error ?? resolve.error)?.message}</p>
        )}
      </RowText>
      <CopyActions path={use.path} skill={use} />
      <OnOffSwitch
        on={use.on}
        disabled={changes.busy || conflict}
        label={`${use.projectName} On`}
        onChange={changes.toggle}
      />
      {changes.dialog}
      {resolve.dialog}
    </div>
  );
}

/** The Skill page's Projects tab: every Project using this Skill, as a Link or a Copy, with status and On/Off. */
export function SkillProjects({ skill }: { skill: SkillDetail }) {
  const trpc = useTRPC();
  const uses = useQuery(trpc.project.forSkill.queryOptions({ key: skill.key }));
  const list = uses.data ?? [];
  if (uses.isPending) return null;
  if (list.length === 0)
    return (
      <p className="text-muted-foreground text-body">No Project uses this Skill yet. Add it from a Project page.</p>
    );
  return (
    <div className={openList}>
      {list.map((use) => (
        <ProjectUseRow key={use.path} use={use} />
      ))}
    </div>
  );
}
