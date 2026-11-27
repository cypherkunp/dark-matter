import type { ImportCandidate, ImportPreview, ImportResult } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type FormEvent, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AddToProjectsDialog } from "@/components/add-to-projects";
import { StarSourceButton } from "@/components/favourites";
import { markdownComponents } from "@/components/skill-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/lib/trpc";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What you can paste (#11). A loose check, for offering Import from the Add Skills dialog; the core decides. */
export const looksLikeGitHubSource = (text: string) =>
  /^(https?:\/\/)?(www\.)?(github\.com|skills\.sh)\//i.test(text.trim()) ||
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text.trim());

/** SKILL.md without its frontmatter, for Preview. */
const bodyOf = (skillMd: string) => skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

const authLabel: Record<ImportPreview["auth"], string> = {
  gh: "using your gh login",
  pat: "using your GitHub token",
  anonymous: "anonymously (public repos only)",
};

const outcomeLabel: Record<ImportResult["skills"][number]["outcome"], string> = {
  imported: "Imported",
  upToDate: "Already in the Library, up to date",
  updateAvailable: "Already in the Library, update available",
};

function CandidateRow({
  skill,
  checked,
  onToggle,
}: {
  skill: ImportCandidate;
  checked: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="import-candidate" className="flex flex-col">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <input
          type="checkbox"
          aria-label={`Import ${skill.name}`}
          className="size-4 accent-primary"
          checked={checked}
          onChange={onToggle}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="font-medium text-body">{skill.name}</span>
            {skill.inLibrary && (
              <span className="rounded-full border px-2 py-px text-micro text-muted-foreground">in Library</span>
            )}
          </div>
          <span className="truncate text-muted-foreground text-meta">{skill.description}</span>
          <span className="truncate font-mono text-micro text-muted-foreground">{skill.path}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
          {open ? <ChevronDown /> : <ChevronRight />}
          Preview
        </Button>
      </div>
      {open && (
        <div data-testid="import-preview" className="border-t bg-muted/30 px-6 py-3 text-body">
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {bodyOf(skill.skillMd)}
          </Markdown>
        </div>
      )}
    </div>
  );
}

/** The picker: every Skill the Source has at the tracked ref's head, then Import and Add to Projects. */
function Picker({ input, preview, project }: { input: string; preview: ImportPreview; project: string | null }) {
  const trpc = useTRPC();
  const [picked, setPicked] = useState(
    () => new Set(preview.skills.filter((skill) => skill.selected).map((skill) => skill.path)),
  );
  const [adding, setAdding] = useState<string[] | null>(null);
  const run = useMutation(
    trpc.importer.import.mutationOptions({
      onSuccess: (result) => setAdding(result.skills.map((skill) => skill.key)),
    }),
  );
  const toggle = (path: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold text-section">
          {plural(preview.skills.length, "Skill")} in{" "}
          <span className="font-mono">
            {preview.source}
            {preview.subpath ? `/${preview.subpath}` : ""}
          </span>
        </h2>
        <span className="font-mono text-muted-foreground text-meta">
          {preview.ref} @ {preview.commit.slice(0, 7)} · {authLabel[preview.auth]}
        </span>
      </div>
      {preview.skills.length === 0 ? (
        <p className="text-muted-foreground text-body">No Skills found here.</p>
      ) : (
        <div className="divide-y rounded-xl border">
          {preview.skills.map((skill) => (
            <CandidateRow
              key={skill.path}
              skill={skill}
              checked={picked.has(skill.path)}
              onToggle={() => toggle(skill.path)}
            />
          ))}
        </div>
      )}
      {run.error && <p className="text-body text-status-warning">{run.error.message}</p>}
      {run.data && (
        <ul data-testid="import-result" className="flex flex-col gap-1 text-body">
          {run.data.skills.map((skill) => (
            <li key={skill.key}>
              <span className="font-mono">{skill.key}</span>{" "}
              <span className="text-muted-foreground">{outcomeLabel[skill.outcome]}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <StarSourceButton source={preview.source} />
        <Button
          disabled={picked.size === 0 || run.isPending}
          onClick={() => run.mutate({ input, commit: preview.commit, paths: [...picked] })}
        >
          {run.isPending ? "Importing…" : `Import ${plural(picked.size, "Skill")}`}
        </Button>
      </div>
      {adding && adding.length > 0 && (
        <AddToProjectsDialog
          keys={adding}
          ticked={project ? [project] : []}
          title="Add the Imported Skills to Projects"
          onClose={() => setAdding(null)}
        />
      )}
    </section>
  );
}

/**
 * GitHub Import (#30): paste `owner/repo`, a repo or tree URL, or a skills.sh
 * listing URL, pick Skills, Import them into the Library, then add them to
 * Projects. `project` is the Project the Import started from (pre-ticked).
 */
export function GitHubImport({ initialUrl, project }: { initialUrl: string; project: string | null }) {
  const trpc = useTRPC();
  const [text, setText] = useState(initialUrl);
  const [input, setInput] = useState(initialUrl.trim());
  const preview = useQuery({
    ...trpc.importer.preview.queryOptions({ input }),
    enabled: input !== "",
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setInput(text.trim());
  };
  return (
    <div className="flex flex-col gap-6">
      <form className="flex gap-2" onSubmit={submit}>
        <Input
          aria-label="GitHub Source"
          placeholder="owner/repo, a GitHub URL or a skills.sh link"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" disabled={text.trim() === "" || preview.isFetching}>
          {preview.isFetching ? "Looking…" : "Find Skills"}
        </Button>
      </form>
      {preview.error && <p className="text-body text-status-warning">{preview.error.message}</p>}
      {preview.data && (
        <Picker key={`${input}@${preview.data.commit}`} input={input} preview={preview.data} project={project} />
      )}
    </div>
  );
}
