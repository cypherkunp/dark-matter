import type { SuggestedProject } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FolderPlus, FolderSearch } from "lucide-react";
import { PageHead } from "@/components/page-head";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { useScan } from "@/components/use-scan";
import { agentName } from "@/lib/agents";
import { tildify } from "@/lib/paths";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/projects/suggested")({ component: Suggested });

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function Row({ suggestion }: { suggestion: SuggestedProject }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const manage = useMutation(
    trpc.project.add.mutationOptions({
      onSuccess: (project) => navigate({ to: "/project", search: { path: project.path } }),
    }),
  );
  const dismiss = useMutation(trpc.project.dismiss.mutationOptions());
  const busy = manage.isPending || dismiss.isPending;
  return (
    <div data-testid="suggested-project" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <StatusDot tone="warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium text-body">{suggestion.name}</span>
        <div className="truncate font-mono text-muted-foreground text-meta">
          {[tildify(suggestion.path), suggestion.git ? "git" : "no git"].join(" · ")}
        </div>
        <div className="text-muted-foreground text-meta">
          Seen in {suggestion.agents.map((agent) => agentName(agent)).join(", ")}
        </div>
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => dismiss.mutate({ path: suggestion.path })}>
        Dismiss
      </Button>
      <Button size="sm" disabled={busy} onClick={() => manage.mutate({ path: suggestion.path })}>
        Manage
      </Button>
    </div>
  );
}

/** Add folder…: a Project no Agent has opened yet (the git toplevel of the chosen folder). */
function AddFolderButton({ variant = "outline" }: { variant?: "outline" | "default" }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const add = useMutation(
    trpc.project.add.mutationOptions({
      onSuccess: (project) => navigate({ to: "/project", search: { path: project.path } }),
    }),
  );
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={add.isPending}
      onClick={async () => {
        const path = await window.darkMatter.chooseFolder("Add a folder as a Project");
        if (path) add.mutate({ path });
      }}
    >
      <FolderPlus />
      Add folder…
    </Button>
  );
}

function Suggested() {
  const trpc = useTRPC();
  const suggested = useQuery(trpc.project.suggested.queryOptions());
  const { scan, scanning, lastScanAt } = useScan();
  const list = suggested.data?.suggested ?? [];
  const dismissed = suggested.data?.dismissedCount ?? 0;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <div className="flex items-start justify-between gap-4">
        <PageHead
          title="Suggested"
          summary={`${plural(list.length, "Suggested Project")}${dismissed ? ` · ${dismissed} dismissed` : ""}`}
          status="From each Agent's own history. Dark Matter only manages folders you confirm."
        />
        <AddFolderButton />
      </div>
      {suggested.isPending ? null : list.length === 0 ? (
        <section
          data-testid="suggested-empty"
          className="flex flex-col items-center gap-3 rounded-xl border px-6 py-16 text-center"
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <FolderSearch className="size-5 text-muted-foreground" />
          </div>
          <h2 className="font-semibold text-heading">{lastScanAt ? "No Suggested Projects" : "No Scan yet"}</h2>
          <p className="max-w-sm text-muted-foreground text-body">
            A Scan reads where Claude Code, Cursor, OpenCode and Codex were used and suggests those folders. Nothing on
            your disk is crawled.
          </p>
          <Button size="sm" variant="outline" disabled={scanning} onClick={scan}>
            {scanning ? "Scanning…" : "Scan now"}
          </Button>
        </section>
      ) : (
        <div className="divide-y rounded-xl border">
          {list.map((suggestion) => (
            <Row key={suggestion.path} suggestion={suggestion} />
          ))}
        </div>
      )}
    </div>
  );
}
