import type { FrontmatterWarning, SkillDetail, SkillFileEntry } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { File, Folder, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { CodeEditor } from "@/components/code-editor";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type TreeRow =
  | { kind: "folder"; path: string; name: string; depth: number }
  | (SkillFileEntry & { kind: "file"; name: string; depth: number });

/** The flat file list as tree rows: each folder once, before its files. */
const treeRows = (files: SkillFileEntry[]): TreeRow[] => {
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const path = parts.slice(0, depth + 1).join("/");
      if (seen.has(path)) continue;
      seen.add(path);
      rows.push({ kind: "folder", path, name: parts[depth] ?? path, depth });
    }
    rows.push({ ...file, kind: "file", name: parts.at(-1) ?? file.path, depth: parts.length - 1 });
  }
  return rows;
};

const confirmDiscard = () => window.confirm("Discard unsaved changes?");

/** The Files tab (#34): the Skill's file tree and a CodeMirror editor with dirty state and ⌘S. */
export function SkillFiles({ skill }: { skill: SkillDetail }) {
  const trpc = useTRPC();
  const files = useQuery(trpc.skill.files.queryOptions({ key: skill.key }));
  const [selected, setSelected] = useState("SKILL.md");
  const file = useQuery(trpc.skill.readFile.queryOptions({ key: skill.key, path: selected }));
  /** The file as on disk (last load or save); `seed` bumps only when the editor must reload from it. */
  const [loaded, setLoaded] = useState<{ path: string; content: string; seed: number } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<FrontmatterWarning[] | null>(null);
  const dirty = loaded !== null && draft !== null && draft !== loaded.content;

  // Load a newly selected file, or a change made on disk while there's nothing unsaved.
  useEffect(() => {
    const content = file.data?.content;
    if (content == null || file.data?.path !== selected) return;
    if (loaded?.path === selected && (dirty || loaded.content === content)) return;
    setLoaded({ path: selected, content, seed: (loaded?.seed ?? 0) + 1 });
    setDraft(content);
  }, [file.data, selected, loaded, dirty]);

  const save = useMutation(
    trpc.skill.saveFile.mutationOptions({
      onSuccess: (result, input) => {
        setLoaded((current) => current && { ...current, content: input.content });
        setWarnings(result.warnings);
      },
    }),
  );
  const onSave = () => {
    if (loaded && draft !== null && dirty && !save.isPending) {
      save.mutate({ key: skill.key, path: loaded.path, content: draft });
    }
  };

  // Leaving the window with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const open = (path: string) => {
    if (path === selected || (dirty && !confirmDiscard())) return;
    setSelected(path);
    setLoaded(null);
    setDraft(null);
    setWarnings(null);
    save.reset();
  };

  return (
    <div className="flex h-[calc(100vh-16rem)] min-h-96 overflow-hidden rounded-xl border">
      <nav aria-label="Files" className="w-56 shrink-0 overflow-y-auto border-r bg-muted/30 py-2">
        {treeRows(files.data?.files ?? []).map((row) =>
          row.kind === "folder" ? (
            <div
              key={`dir:${row.path}`}
              className="flex items-center gap-1.5 px-3 py-1 text-muted-foreground text-meta"
              style={{ paddingLeft: `${0.75 + row.depth * 0.75}rem` }}
            >
              <Folder className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{row.name}</span>
            </div>
          ) : (
            <button
              key={row.path}
              type="button"
              data-testid="skill-file"
              aria-current={row.path === selected ? "true" : undefined}
              onClick={() => open(row.path)}
              className={cn(
                "flex w-full items-center gap-1.5 px-3 py-1 text-left text-meta hover:bg-muted",
                row.path === selected && "bg-muted font-medium",
              )}
              style={{ paddingLeft: `${0.75 + row.depth * 0.75}rem` }}
            >
              <File className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono">{row.name}</span>
              {row.path === selected && dirty && (
                <span
                  data-testid="dirty-dot"
                  title="Unsaved changes"
                  className="ml-auto size-1.5 rounded-full bg-status-warning"
                />
              )}
            </button>
          ),
        )}
      </nav>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <span className="truncate font-mono text-muted-foreground text-meta">{selected}</span>
          <span data-testid="save-state" className="ml-auto text-muted-foreground text-meta">
            {save.isPending ? "Saving…" : dirty ? "Unsaved changes" : save.isSuccess ? "Saved" : ""}
          </span>
          <Button size="sm" variant="outline" disabled={!dirty || save.isPending} onClick={onSave}>
            Save <kbd className="text-muted-foreground">⌘S</kbd>
          </Button>
        </div>
        {(save.error || (warnings && warnings.length > 0)) && (
          <ul
            data-testid="save-warnings"
            className="flex flex-col gap-1 border-warning-border border-b bg-warning-surface px-4 py-2 text-body"
          >
            {save.error && <li>{save.error.message}</li>}
            {warnings?.map((warning) => (
              <li key={warning.message} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
                <span>{warning.message}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="min-h-0 flex-1">
          {file.error ? (
            <p className="p-4 text-muted-foreground text-body">{file.error.message}</p>
          ) : file.data?.binary ? (
            <p className="p-4 text-muted-foreground text-body">A binary file can't be edited here.</p>
          ) : loaded ? (
            <CodeEditor
              key={`${loaded.path}:${loaded.seed}`}
              path={loaded.path}
              initial={loaded.content}
              onChange={setDraft}
              onSave={onSave}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
