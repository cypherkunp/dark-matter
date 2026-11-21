import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const cell = (path: string, key: string) => `${path}\n${key}`;

export interface AddToProjectsProps {
  /** Library keys to offer (the grid's rows). The dialog is open while there are any. */
  keys: readonly string[];
  /** Projects (absolute paths) whose column starts ticked, e.g. the Project an Import started from. */
  ticked?: readonly string[];
  title?: string;
  description?: string;
  onClose: () => void;
}

/**
 * The Add to Projects grid (#29): Library Skills × confirmed Projects. Each
 * ticked cell becomes an ordinary Project Skill, delivered as a Link, through
 * `project.addSkills` in one go. Cells a Project already has are shown ticked
 * and fixed. Reused after a bulk Adopt, from the Skill page, after an Import
 * and on skills.sh Get, and in the First run.
 */
export function AddToProjectsDialog({
  keys,
  ticked = [],
  title = "Add to Projects",
  description = "Each ticked Skill is added to that Project as a Link: a personal symlink to the Library, excluded from git.",
  onClose,
}: AddToProjectsProps) {
  const trpc = useTRPC();
  const projects = useQuery(trpc.project.list.queryOptions());
  const library = useQuery(trpc.library.list.queryOptions());
  const columns = (projects.data ?? []).filter((project) => project.exists);
  const existing = useQueries({
    queries: columns.map((project) => trpc.project.skills.queryOptions({ path: project.path })),
  });
  const has = new Set(
    columns.flatMap((project, at) => (existing[at]?.data ?? []).map((skill) => cell(project.path, skill.key))),
  );
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(ticked.flatMap((path) => keys.map((key) => cell(path, key)))),
  );
  const add = useMutation(trpc.project.addSkills.mutationOptions({ onSuccess: onClose }));
  const chosen = [...picked].filter((id) => !has.has(id));
  const nameOf = (key: string) => library.data?.skills.find((skill) => skill.key === key)?.name ?? key;
  const toggle = (ids: string[]) =>
    setPicked((current) => {
      const open = ids.filter((id) => !has.has(id));
      const next = new Set(current);
      const all = open.every((id) => current.has(id));
      for (const id of open) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  return (
    <Dialog.Root open={keys.length > 0} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(52rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-lg">{title}</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-sm">{description}</Dialog.Description>
          {projects.isPending ? null : columns.length === 0 ? (
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
                      {columns.map((project) => {
                        const id = cell(project.path, key);
                        const already = has.has(id);
                        return (
                          <td key={project.path} className="px-3 py-2.5 text-center">
                            <input
                              type="checkbox"
                              aria-label={`${nameOf(key)} in ${project.name}`}
                              title={already ? `Already in ${project.name}` : undefined}
                              className="size-4 accent-primary disabled:opacity-50"
                              checked={already || picked.has(id)}
                              disabled={already}
                              onChange={() => toggle([id])}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {add.error && <p className="text-sm text-status-warning">{add.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>{chosen.length ? "Cancel" : "Skip"}</Dialog.Close>
            <Button
              disabled={chosen.length === 0 || add.isPending}
              onClick={() =>
                add.mutate({
                  skills: chosen.map((id) => {
                    const [path = "", key = ""] = id.split("\n");
                    return { path, key };
                  }),
                })
              }
            >
              Add {plural(chosen.length, "Link")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
