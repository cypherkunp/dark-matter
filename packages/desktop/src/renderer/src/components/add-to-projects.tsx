import { Dialog } from "@base-ui/react/dialog";
import type { CollectionCell, DeliveryMode } from "@dark-matter/contracts";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const cell = (path: string, key: string) => `${path}\n${key}`;

const modeLabels: Record<DeliveryMode, string> = { link: "Link", copy: "Copy" };

export interface AddToProjectsProps {
  /** Library keys to offer (the grid's rows). The dialog is open while there are any. */
  keys: readonly string[];
  /** Projects (absolute paths) whose column starts ticked, e.g. the Project an Import started from. */
  ticked?: readonly string[];
  /** Only these Projects (absolute paths) as columns, e.g. the one the First run is setting up. Default: every Project. */
  projects?: readonly string[];
  /**
   * Adding a Collection (#36): its name. The grid then shows, per cell, a Name
   * Conflict or a folder in the way, and applies through `collections.execute`.
   */
  collection?: string;
  title?: string;
  description?: string;
  onClose: () => void;
}

/** Why a cell can't be ticked, or what it will run into, from a Collection's plan. */
const cellNote = (planned: CollectionCell | undefined, projectName: string) => {
  if (!planned) return undefined;
  if (planned.outcome === "present") return `Already in ${projectName}`;
  if (planned.outcome === "blocked") return `${planned.blockedBy ?? "Its folder"} is taken by something else`;
  if (planned.outcome === "nameConflict")
    return `Name Conflict with ${planned.conflictsWith.join(", ")}: it's added, then Resolve on the Project page`;
  return undefined;
};

const outcomeText: Record<CollectionCell["outcome"], string> = {
  add: "added",
  present: "already there",
  nameConflict: "added in a Name Conflict (Resolve on the Project page)",
  blocked: "skipped: its folder is taken",
  missing: "skipped: no longer in the Library",
};

/**
 * The Add to Projects grid (#29): Library Skills × confirmed Projects. Each
 * ticked cell becomes an ordinary Project Skill, delivered as a Link or a Copy
 * (chosen per Skill; Link by default), in one go. Cells a Project already has
 * are shown ticked and fixed. Reused after a bulk Adopt, from the Skill page,
 * after an Import and on skills.sh Get, for Collections, and in the First run.
 */
export function AddToProjectsDialog({
  keys,
  ticked = [],
  projects: only,
  collection,
  title = "Add to Projects",
  description = "Each ticked Skill is added to that Project. A Link is a personal symlink to the Library, excluded from git; a Copy is committed for your team.",
  onClose,
}: AddToProjectsProps) {
  const trpc = useTRPC();
  const projects = useQuery(trpc.project.list.queryOptions());
  const library = useQuery(trpc.library.list.queryOptions());
  const columns = (projects.data ?? []).filter(
    (project) => project.exists && (only === undefined || only.includes(project.path)),
  );
  const [modes, setModes] = useState<Record<string, DeliveryMode>>({});
  const modeOf = (key: string) => modes[key] ?? "link";
  const existing = useQueries({
    queries: collection ? [] : columns.map((project) => trpc.project.skills.queryOptions({ path: project.path })),
  });
  const plan = useQuery({
    ...trpc.collections.plan.queryOptions({
      name: collection ?? "",
      projects: columns.map((project) => project.path),
      modes,
    }),
    enabled: collection !== undefined && columns.length > 0,
  });
  const planned = new Map((plan.data?.cells ?? []).map((found) => [cell(found.path, found.key), found]));
  const has = new Set(
    collection
      ? [...planned].filter(([, found]) => found.outcome === "present").map(([id]) => id)
      : columns.flatMap((project, at) => (existing[at]?.data ?? []).map((skill) => cell(project.path, skill.key))),
  );
  const fixed = (id: string) => has.has(id) || planned.get(id)?.outcome === "blocked";
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(ticked.flatMap((path) => keys.map((key) => cell(path, key)))),
  );
  const add = useMutation(trpc.project.addSkills.mutationOptions({ onSuccess: onClose }));
  const apply = useMutation(
    trpc.collections.execute.mutationOptions({
      onSuccess: (result) => {
        if (result.cells.every((found) => found.outcome === "add")) onClose();
      },
    }),
  );
  const pending = add.isPending || apply.isPending;
  const error = add.error ?? apply.error;
  const chosen = [...picked].filter((id) => !fixed(id));
  const nameOf = (key: string) => library.data?.skills.find((skill) => skill.key === key)?.name ?? key;
  const projectName = (path: string) => columns.find((project) => project.path === path)?.name ?? path;
  const toggle = (ids: string[]) =>
    setPicked((current) => {
      const open = ids.filter((id) => !fixed(id));
      const next = new Set(current);
      const all = open.every((id) => current.has(id));
      for (const id of open) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  const submit = () => {
    const skills = chosen.map((id) => {
      const [path = "", key = ""] = id.split("\n");
      return { path, key, mode: modeOf(key) };
    });
    if (collection) apply.mutate({ name: collection, skills });
    else add.mutate({ skills });
  };
  const copies = chosen.filter((id) => modeOf(id.split("\n")[1] ?? "") === "copy").length;
  const result = apply.data?.cells.filter((found) => found.outcome !== "add");

  return (
    <Dialog.Root open={keys.length > 0} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(56rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-lg">{title}</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-sm">{description}</Dialog.Description>
          {result ? (
            <div data-testid="collection-apply-result" className="flex flex-col gap-2 text-sm">
              <p>
                {plural(apply.data?.cells.filter((found) => found.outcome === "add").length ?? 0, "Skill")} added. Some
                need a look:
              </p>
              <ul className="divide-y rounded-xl border">
                {result.map((found) => (
                  <li key={cell(found.path, found.key)} className="flex items-center gap-2 px-4 py-2">
                    <TriangleAlert className="size-3.5 shrink-0 text-status-warning" />
                    <span className="font-mono text-[12px]">{found.key}</span>
                    <span className="text-muted-foreground">in {projectName(found.path)}:</span>
                    <span>{outcomeText[found.outcome]}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : projects.isPending ? null : columns.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No Projects yet. Confirm a Suggested Project or add a folder, then add Skills from its page.
            </p>
          ) : (
            <div className="min-h-0 overflow-auto rounded-xl border">
              <table data-testid="add-to-projects-grid" className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="sticky left-0 bg-background px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">
                      {plural(keys.length, "Skill")}
                    </th>
                    <th className="px-3 py-2.5 text-left font-medium text-muted-foreground text-xs">Deliver as</th>
                    {columns.map((project) => (
                      <th key={project.path} className="px-3 py-2.5 font-medium text-xs" title={project.path}>
                        <button
                          type="button"
                          className="hover:underline"
                          onClick={() => toggle(keys.map((key) => cell(project.path, key)))}
                        >
                          {project.name}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {keys.map((key) => (
                    <tr key={key} data-testid="add-to-projects-row">
                      <th scope="row" className="sticky left-0 bg-background px-4 py-2.5 text-left font-normal">
                        <button
                          type="button"
                          className="flex flex-col items-start hover:underline"
                          onClick={() => toggle(columns.map((project) => cell(project.path, key)))}
                        >
                          <span>{nameOf(key)}</span>
                          <span className="font-mono text-[11px] text-muted-foreground">{key}</span>
                        </button>
                      </th>
                      <td className="px-3 py-2.5">
                        <div
                          role="radiogroup"
                          aria-label={`Deliver ${nameOf(key)} as`}
                          className="inline-flex rounded-md border p-0.5"
                        >
                          {(["link", "copy"] as const).map((option) => (
                            <label
                              key={option}
                              className={cn(
                                "cursor-pointer rounded px-2 py-0.5 text-xs has-focus-visible:ring-2 has-focus-visible:ring-ring",
                                modeOf(key) === option ? "bg-muted font-medium" : "text-muted-foreground",
                              )}
                            >
                              <input
                                type="radio"
                                name={`mode-${key}`}
                                className="sr-only"
                                checked={modeOf(key) === option}
                                onChange={() => setModes((current) => ({ ...current, [key]: option }))}
                              />
                              {modeLabels[option]}
                            </label>
                          ))}
                        </div>
                      </td>
                      {columns.map((project) => {
                        const id = cell(project.path, key);
                        const found = planned.get(id);
                        const note = cellNote(found, project.name) ?? (has.has(id) ? `Already in ${project.name}` : "");
                        const warn = found?.outcome === "blocked" || found?.outcome === "nameConflict";
                        return (
                          <td key={project.path} className="px-3 py-2.5 text-center">
                            <span className="inline-flex items-center gap-1" title={note || undefined}>
                              <input
                                type="checkbox"
                                aria-label={`${nameOf(key)} in ${project.name}`}
                                className="size-4 accent-primary disabled:opacity-50"
                                checked={has.has(id) || (picked.has(id) && !fixed(id))}
                                disabled={fixed(id)}
                                onChange={() => toggle([id])}
                              />
                              {warn && (
                                <TriangleAlert
                                  data-testid="add-to-projects-conflict"
                                  aria-label={note}
                                  className="size-3.5 text-status-warning"
                                />
                              )}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {error && <p className="text-sm text-status-warning">{error.message}</p>}
          <div className="flex justify-end gap-2">
            {result ? (
              <Button onClick={onClose}>Done</Button>
            ) : (
              <>
                <Dialog.Close render={<Button variant="outline" />}>{chosen.length ? "Cancel" : "Skip"}</Dialog.Close>
                <Button disabled={chosen.length === 0 || pending} onClick={submit}>
                  Add{" "}
                  {copies === 0
                    ? plural(chosen.length, "Link")
                    : copies === chosen.length
                      ? plural(chosen.length, "Copy").replace("Copys", "Copies")
                      : plural(chosen.length, "Skill")}
                </Button>
              </>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
