import { Dialog } from "@base-ui/react/dialog";
import {
  type CollectionCell,
  type CollectionMcpCell,
  type DeliveryMode,
  McpDeliveryMode,
} from "@dark-matter/contracts";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const cell = (path: string, key: string) => `${path}\n${key}`;

const modeLabels: Record<DeliveryMode, string> = { link: "Link", copy: "Copy" };

/** Collection MCP Servers (#41) share the grid; their cell ids carry a prefix so a name never meets a Skill key. */
const serverRow = (name: string) => `mcp:${name}`;

const mcpModeLabel = (mode: McpDeliveryMode) => `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;

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
  /** With `collection`: its Library MCP Servers (#41), added as Project MCP Servers (Personal by default). */
  servers?: readonly string[];
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

/** Why an MCP Server cell can't be ticked. */
const serverNote = (planned: CollectionMcpCell | undefined, projectName: string) => {
  if (!planned) return undefined;
  if (planned.outcome === "present") return `Already in ${projectName}`;
  if (planned.outcome === "blocked")
    return planned.blockedBy
      ? `${planned.blockedBy} is taken by something else`
      : (planned.problem ?? "Can't be added");
  return undefined;
};

const mcpOutcomeText = (found: CollectionMcpCell) =>
  found.outcome === "present"
    ? "already there"
    : found.outcome === "missing"
      ? "skipped: no longer in the Library"
      : found.outcome === "blocked"
        ? `skipped: ${found.blockedBy ? `${found.blockedBy} is taken` : (found.problem ?? "can't be added")}`
        : "added";

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
  servers = [],
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
  const [mcpModes, setMcpModes] = useState<Record<string, McpDeliveryMode>>({});
  const mcpModeOf = (name: string) => mcpModes[name] ?? "personal";
  const existing = useQueries({
    queries: collection ? [] : columns.map((project) => trpc.project.skills.queryOptions({ path: project.path })),
  });
  const plan = useQuery({
    ...trpc.collections.plan.queryOptions({
      name: collection ?? "",
      projects: columns.map((project) => project.path),
      modes,
      mcpModes,
    }),
    enabled: collection !== undefined && columns.length > 0,
  });
  const planned = new Map((plan.data?.cells ?? []).map((found) => [cell(found.path, found.key), found]));
  const plannedServers = new Map(
    (plan.data?.mcpCells ?? []).map((found) => [cell(found.path, serverRow(found.name)), found]),
  );
  const has = new Set(
    collection
      ? [...planned, ...plannedServers].filter(([, found]) => found.outcome === "present").map(([id]) => id)
      : columns.flatMap((project, at) => (existing[at]?.data ?? []).map((skill) => cell(project.path, skill.key))),
  );
  const fixed = (id: string) =>
    has.has(id) || planned.get(id)?.outcome === "blocked" || plannedServers.get(id)?.outcome === "blocked";
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(ticked.flatMap((path) => keys.map((key) => cell(path, key)))),
  );
  const add = useMutation(trpc.project.addSkills.mutationOptions({ onSuccess: onClose }));
  const apply = useMutation(
    trpc.collections.execute.mutationOptions({
      onSuccess: (result) => {
        if ([...result.cells, ...result.mcpCells].every((found) => found.outcome === "add")) onClose();
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
    const split = chosen.map((id) => {
      const [path = "", row = ""] = id.split("\n");
      return { path, row };
    });
    const skills = split
      .filter(({ row }) => !row.startsWith("mcp:"))
      .map(({ path, row }) => ({ path, key: row, mode: modeOf(row) }));
    const mcpServers = split
      .filter(({ row }) => row.startsWith("mcp:"))
      .map(({ path, row }) => {
        const name = row.slice("mcp:".length);
        return { path, name, mode: mcpModeOf(name) };
      });
    if (collection) apply.mutate({ name: collection, skills, mcpServers });
    else add.mutate({ skills });
  };
  const chosenServers = chosen.filter((id) => id.split("\n")[1]?.startsWith("mcp:")).length;
  const chosenSkills = chosen.length - chosenServers;
  const copies = chosen.filter((id) => modeOf(id.split("\n")[1] ?? "") === "copy").length;
  const skillsLabel =
    copies === 0
      ? plural(chosenSkills, "Link")
      : copies === chosenSkills
        ? plural(chosenSkills, "Copy").replace("Copys", "Copies")
        : plural(chosenSkills, "Skill");
  const submitLabel =
    chosenServers === 0
      ? skillsLabel
      : chosenSkills === 0
        ? plural(chosenServers, "MCP Server")
        : `${plural(chosenSkills, "Skill")} and ${plural(chosenServers, "MCP Server")}`;
  const result = apply.data?.cells.filter((found) => found.outcome !== "add");
  const mcpResult = apply.data?.mcpCells.filter((found) => found.outcome !== "add") ?? [];
  const added =
    (apply.data?.cells.filter((found) => found.outcome === "add").length ?? 0) +
    (apply.data?.mcpCells.filter((found) => found.outcome === "add").length ?? 0);

  return (
    <Dialog.Root open={keys.length + servers.length > 0} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(56rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-heading">{title}</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-body">{description}</Dialog.Description>
          {result && (result.length > 0 || mcpResult.length > 0) ? (
            <div data-testid="collection-apply-result" className="flex flex-col gap-2 text-body">
              <p>{plural(added, "item")} added. Some need a look:</p>
              <ul className="divide-y rounded-xl border">
                {result.map((found) => (
                  <li key={cell(found.path, found.key)} className="flex items-center gap-2 px-4 py-2">
                    <TriangleAlert className="size-3.5 shrink-0 text-status-warning" />
                    <span className="font-mono text-meta">{found.key}</span>
                    <span className="text-muted-foreground">in {projectName(found.path)}:</span>
                    <span>{outcomeText[found.outcome]}</span>
                  </li>
                ))}
                {mcpResult.map((found) => (
                  <li key={cell(found.path, serverRow(found.name))} className="flex items-center gap-2 px-4 py-2">
                    <TriangleAlert className="size-3.5 shrink-0 text-status-warning" />
                    <span className="font-mono text-meta">{found.name}</span>
                    <span className="text-muted-foreground">in {projectName(found.path)}:</span>
                    <span>{mcpOutcomeText(found)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : projects.isPending ? null : columns.length === 0 ? (
            <p className="text-muted-foreground text-body">
              No Projects yet. Confirm a Suggested Project or add a folder, then add Skills from its page.
            </p>
          ) : (
            <div className="min-h-0 overflow-auto rounded-xl border">
              <table data-testid="add-to-projects-grid" className="w-full border-collapse text-body">
                <thead>
                  <tr className="border-b">
                    <th className="sticky left-0 bg-background px-4 py-2.5 text-left font-medium text-muted-foreground text-meta">
                      {servers.length === 0
                        ? plural(keys.length, "Skill")
                        : `${plural(keys.length, "Skill")}, ${plural(servers.length, "MCP Server")}`}
                    </th>
                    <th className="px-3 py-2.5 text-left font-medium text-muted-foreground text-meta">Deliver as</th>
                    {columns.map((project) => (
                      <th key={project.path} className="px-3 py-2.5 font-medium text-meta" title={project.path}>
                        <button
                          type="button"
                          className="hover:underline"
                          onClick={() =>
                            toggle([...keys, ...servers.map(serverRow)].map((row) => cell(project.path, row)))
                          }
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
                          <span className="font-mono text-micro text-muted-foreground">{key}</span>
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
                                "cursor-pointer rounded px-2 py-0.5 text-meta has-focus-visible:ring-2 has-focus-visible:ring-ring",
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
                  {servers.map((name) => (
                    <tr key={serverRow(name)} data-testid="add-to-projects-server-row">
                      <th scope="row" className="sticky left-0 bg-background px-4 py-2.5 text-left font-normal">
                        <button
                          type="button"
                          className="flex flex-col items-start hover:underline"
                          onClick={() => toggle(columns.map((project) => cell(project.path, serverRow(name))))}
                        >
                          <span>{name}</span>
                          <span className="text-micro text-muted-foreground">MCP Server</span>
                        </button>
                      </th>
                      <td className="px-3 py-2.5">
                        <div
                          role="radiogroup"
                          aria-label={`Deliver ${name} as`}
                          className="inline-flex rounded-md border p-0.5"
                        >
                          {McpDeliveryMode.options.map((option) => (
                            <label
                              key={option}
                              className={cn(
                                "cursor-pointer rounded px-2 py-0.5 text-meta has-focus-visible:ring-2 has-focus-visible:ring-ring",
                                mcpModeOf(name) === option ? "bg-muted font-medium" : "text-muted-foreground",
                              )}
                            >
                              <input
                                type="radio"
                                name={`mcp-mode-${name}`}
                                className="sr-only"
                                checked={mcpModeOf(name) === option}
                                onChange={() => setMcpModes((current) => ({ ...current, [name]: option }))}
                              />
                              {mcpModeLabel(option)}
                            </label>
                          ))}
                        </div>
                      </td>
                      {columns.map((project) => {
                        const id = cell(project.path, serverRow(name));
                        const found = plannedServers.get(id);
                        const note = serverNote(found, project.name) ?? "";
                        return (
                          <td key={project.path} className="px-3 py-2.5 text-center">
                            <span className="inline-flex items-center gap-1" title={note || undefined}>
                              <input
                                type="checkbox"
                                aria-label={`${name} in ${project.name}`}
                                className="size-4 accent-primary disabled:opacity-50"
                                checked={has.has(id) || (picked.has(id) && !fixed(id))}
                                disabled={fixed(id)}
                                onChange={() => toggle([id])}
                              />
                              {found?.outcome === "blocked" && (
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
          {error && <p className="text-body text-status-warning">{error.message}</p>}
          <div className="flex justify-end gap-2">
            {result && (result.length > 0 || mcpResult.length > 0) ? (
              <Button onClick={onClose}>Done</Button>
            ) : (
              <>
                <Dialog.Close render={<Button variant="outline" />}>{chosen.length ? "Cancel" : "Skip"}</Dialog.Close>
                <Button disabled={chosen.length === 0 || pending} onClick={submit}>
                  Add {submitLabel}
                </Button>
              </>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
