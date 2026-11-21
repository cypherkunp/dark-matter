import { Dialog } from "@base-ui/react/dialog";
import type { ProjectSkill } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const pill = "rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground";

/** The On/Off switch for a Project Skill or Project MCP Server: blue On, grey Off. */
export function OnOffSwitch({
  on,
  disabled,
  label,
  onChange,
}: {
  on: boolean;
  disabled: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40",
        on ? "bg-status-on" : "bg-status-off",
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-background transition-transform",
          on ? "translate-x-4.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function ProjectSkillRow({ path, skill }: { path: string; skill: ProjectSkill }) {
  const trpc = useTRPC();
  const setOn = useMutation(trpc.project.setSkillOn.mutationOptions());
  const remove = useMutation(trpc.project.removeSkill.mutationOptions());
  const resolve = useMutation(trpc.project.resolveConflict.mutationOptions());
  const conflict = skill.status === "nameConflict";
  const busy = setOn.isPending || remove.isPending || resolve.isPending;
  const error = setOn.error ?? remove.error ?? resolve.error;
  return (
    <div data-testid="project-skill-row" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <StatusDot tone={conflict ? "warning" : skill.on ? "on" : "off"} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{skill.name}</span>
          <span className={pill}>{skill.namespace}</span>
          <span className={pill}>{skill.mode === "link" ? "Link" : skill.mode}</span>
          {conflict && (
            <span className="rounded-md border border-warning-border bg-warning-surface px-1.5 py-0.5 text-[11px]">
              Name Conflict
            </span>
          )}
        </div>
        <div className="truncate font-mono text-muted-foreground text-xs">
          {conflict ? `also wanted: ${skill.conflictsWith.join(", ")}` : skill.paths.join(" · ")}
        </div>
        {error && <p className="text-status-warning text-xs">{error.message}</p>}
      </div>
      {conflict && (
        <Button
          size="sm"
          variant="outline"
          title={`Keep ${skill.key} and remove ${skill.conflictsWith.join(", ")} from this Project`}
          disabled={busy}
          onClick={() => resolve.mutate({ path, key: skill.key })}
        >
          Resolve: keep this
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove.mutate({ path, key: skill.key })}>
        Remove
      </Button>
      <OnOffSwitch
        on={skill.on}
        disabled={busy || conflict}
        label={`${skill.name} On`}
        onChange={(on) => setOn.mutate({ path, key: skill.key, on })}
      />
    </div>
  );
}

/** + Add Skills: pick Library Skills to add to this Project as Links. */
function AddSkillsDialog({ path, added, onClose }: { path: string; added: string[]; onClose: () => void }) {
  const trpc = useTRPC();
  const library = useQuery(trpc.library.list.queryOptions());
  const [picked, setPicked] = useState<string[]>([]);
  const add = useMutation(trpc.project.addSkills.mutationOptions({ onSuccess: onClose }));
  const candidates = (library.data?.skills ?? []).filter((skill) => !added.includes(skill.key));
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(36rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-lg">Add Skills</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-sm">
            Each Skill is added as a Link: a personal symlink to the Library, excluded from git.
          </Dialog.Description>
          {candidates.length === 0 ? (
            <p className="text-muted-foreground text-sm">Every Library Skill is already in this Project.</p>
          ) : (
            <div className="min-h-0 divide-y overflow-y-auto rounded-xl border">
              {candidates.map((skill) => (
                <label
                  key={skill.key}
                  data-testid="add-skill-option"
                  className="flex cursor-pointer items-center gap-3 px-4 py-2.5"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={picked.includes(skill.key)}
                    onChange={() =>
                      setPicked((current) =>
                        current.includes(skill.key)
                          ? current.filter((key) => key !== skill.key)
                          : [...current, skill.key],
                      )
                    }
                  />
                  <span className="text-sm">{skill.name}</span>
                  <span className={cn(pill, "ml-auto")}>{skill.key}</span>
                </label>
              ))}
            </div>
          )}
          {add.error && <p className="text-sm text-status-warning">{add.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
            <Button
              disabled={picked.length === 0 || add.isPending}
              onClick={() => add.mutate({ skills: picked.map((key) => ({ path, key })) })}
            >
              Add {plural(picked.length, "Skill")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The Project page's Project Skills: name, Namespace, delivery, status and On/Off. */
export function ProjectSkills({ path }: { path: string }) {
  const trpc = useTRPC();
  const skills = useQuery(trpc.project.skills.queryOptions({ path }));
  const [adding, setAdding] = useState(false);
  const list = skills.data ?? [];
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold text-sm">
          Project Skills
          <span className="font-normal text-muted-foreground text-xs tabular-nums">{list.length}</span>
        </h2>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus />
          Add Skills
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="text-muted-foreground text-sm">No Project Skills yet. Add Skills from the Library.</p>
      ) : (
        <div className="divide-y rounded-xl border">
          {list.map((skill) => (
            <ProjectSkillRow key={skill.key} path={path} skill={skill} />
          ))}
        </div>
      )}
      {adding && (
        <AddSkillsDialog path={path} added={list.map((skill) => skill.key)} onClose={() => setAdding(false)} />
      )}
    </section>
  );
}
