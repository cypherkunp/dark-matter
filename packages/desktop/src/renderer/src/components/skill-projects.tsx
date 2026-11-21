import type { SkillDetail, SkillProjectUse } from "@dark-matter/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CopyActions, CopyStateBadge, useProjectSkillChanges, useResolveConflict } from "@/components/copy-actions";
import { modeLabels, OnOffSwitch } from "@/components/project-skills";
import { StatusDot } from "@/components/status-dot";
import { useTRPC } from "@/lib/trpc";

const pill = "rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground";

function ProjectUseRow({ use }: { use: SkillProjectUse }) {
  const changes = useProjectSkillChanges(use.path, use);
  const resolve = useResolveConflict(use.path, use);
  const conflict = use.status === "nameConflict";
  return (
    <div data-testid="skill-project-row" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <StatusDot tone={conflict ? "warning" : use.on ? "on" : "off"} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/project" search={{ path: use.path }} className="font-medium text-sm hover:underline">
            {use.projectName}
          </Link>
          <span data-testid="delivery-mode" className={pill}>
            {modeLabels[use.mode]}
          </span>
          <span className="text-muted-foreground text-xs">{conflict ? "Name Conflict" : use.on ? "On" : "Off"}</span>
          <CopyStateBadge skill={use} />
        </div>
        <div className="truncate font-mono text-muted-foreground text-xs">{use.path}</div>
        {(changes.error ?? resolve.error) && (
          <p className="text-status-warning text-xs">{(changes.error ?? resolve.error)?.message}</p>
        )}
      </div>
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
    return <p className="text-muted-foreground text-sm">No Project uses this Skill yet. Add it from a Project page.</p>;
  return (
    <div className="divide-y rounded-xl border">
      {list.map((use) => (
        <ProjectUseRow key={use.path} use={use} />
      ))}
    </div>
  );
}
