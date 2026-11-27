import type { AgentId, ProjectDetail } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FolderOpen, TriangleAlert } from "lucide-react";
import { FilteredActivity } from "@/components/activity-view";
import { Page } from "@/components/page";
import { PageHead } from "@/components/page-head";
import { ProjectGrant } from "@/components/project-grant";
import { ProjectMcpServers } from "@/components/project-mcp-servers";
import { ProjectSkills } from "@/components/project-skills";
import { RemoveProjectButton } from "@/components/remove-project";
import { RepoSkills } from "@/components/repo-skills";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { tildify } from "@/lib/paths";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/project")({
  validateSearch: (search: Record<string, unknown>): { path: string } => ({
    path: typeof search.path === "string" ? search.path : "",
  }),
  component: ProjectPage,
});

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The folder is gone: point the Project at where it moved, or forget it. */
function GoneBanner({ project }: { project: ProjectDetail }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const locate = useMutation(
    trpc.project.locate.mutationOptions({
      onSuccess: (moved) => navigate({ to: "/project", search: { path: moved.path } }),
    }),
  );
  return (
    <section
      role="alert"
      data-testid="project-gone"
      className="flex items-start gap-3 rounded-xl border border-warning-border bg-warning-surface px-5 py-4"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body">
          <span className="font-mono font-semibold">{tildify(project.path)}</span> is gone
        </p>
        <p className="text-muted-foreground text-meta">
          If the folder moved, point the Project at its new location. Remove forgets the Project and removes its
          Personal MCP entries.
        </p>
        {locate.error && <p className="text-status-warning text-meta">{locate.error.message}</p>}
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={locate.isPending}
        onClick={async () => {
          const newPath = await window.darkMatter.chooseFolder(`Locate ${project.name}`);
          if (newPath) locate.mutate({ path: project.path, newPath });
        }}
      >
        Locate…
      </Button>
      <RemoveProjectButton project={project} />
    </section>
  );
}

/** Which Agents the Project uses, and so which folders Dark Matter writes. */
function AgentPicker({ project }: { project: ProjectDetail }) {
  const trpc = useTRPC();
  const setAgents = useMutation(trpc.project.setAgents.mutationOptions());
  const toggle = (id: AgentId) => {
    const next = project.agents.includes(id) ? project.agents.filter((agent) => agent !== id) : [...project.agents, id];
    if (next.length > 0) setAgents.mutate({ path: project.path, agents: next });
  };
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold text-section">Agents</h2>
      <div className="divide-y rounded-xl border">
        {project.agentOptions.map((option) => {
          const chosen = project.agents.includes(option.id);
          return (
            <label
              key={option.id}
              data-testid="agent-option"
              className="flex min-h-12 cursor-pointer items-center gap-3 px-5 py-2.5"
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={chosen}
                disabled={setAgents.isPending || (chosen && project.agents.length === 1)}
                onChange={() => toggle(option.id)}
              />
              <span className="text-body">{option.name}</span>
              {option.detected && (
                <span className="rounded-md border px-1.5 py-0.5 text-micro text-muted-foreground">detected</span>
              )}
              <span className="ml-auto font-mono text-muted-foreground text-meta">{option.folder}</span>
            </label>
          );
        })}
      </div>
      <p data-testid="project-folders" className="text-muted-foreground text-meta">
        Dark Matter writes Project Skills to{" "}
        {project.folders.map((folder, index) => (
          <span key={folder}>
            {index > 0 && " and "}
            <code className="rounded-md border px-1 py-0.5 font-mono text-micro text-foreground">{folder}</code>
          </span>
        ))}{" "}
        in this Project.
      </p>
    </section>
  );
}

function FoundSkills({ project }: { project: ProjectDetail }) {
  if (project.skills === null) {
    return <p className="text-muted-foreground text-body">Its skill folders are read on the next Scan.</p>;
  }
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-semibold text-section">
        Skills in its folders
        <span className="font-normal text-muted-foreground text-meta tabular-nums">{project.skills.length}</span>
      </h2>
      {project.skills.length === 0 ? (
        <p className="text-muted-foreground text-body">
          The last Scan found no Skills in this Project's skill folders.
        </p>
      ) : (
        <div className="divide-y rounded-xl border">
          {project.skills.map((skill) => (
            <div key={skill.path} data-testid="project-skill" className="flex min-h-16 items-center gap-3 px-5 py-3">
              <StatusDot tone="off" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-body">{skill.name}</span>
                {skill.description && <p className="truncate text-muted-foreground text-meta">{skill.description}</p>}
              </div>
              <span className="rounded-md border px-1.5 py-0.5 font-mono text-micro text-muted-foreground">
                {skill.folder}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Untracked Skills in this Project wait in the Inbox for Adopt & keep Link (#29). */
function UntrackedBanner({ path }: { path: string }) {
  const trpc = useTRPC();
  const inbox = useQuery(trpc.inbox.list.queryOptions());
  const count = inbox.data?.untrackedSkills.find((group) => group.project === path)?.findings.length ?? 0;
  if (count === 0) return null;
  return (
    <Link
      to="/inbox"
      data-testid="project-untracked"
      className="flex items-start gap-3 rounded-xl border border-warning-border bg-warning-surface px-5 py-4 hover:opacity-90"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body">{plural(count, "untracked Skill")} in this Project</p>
        <p className="text-muted-foreground text-meta">
          Adopt them from the Inbox: each moves into the Library and a Link goes back, so this Project sees no change.
        </p>
      </div>
    </Link>
  );
}

function ProjectPage() {
  const { path } = Route.useSearch();
  const trpc = useTRPC();
  const project = useQuery(trpc.project.get.queryOptions({ path }, { enabled: path !== "" }));

  if (project.error) {
    return (
      <Page>
        <PageHead title="Project" summary={project.error.message} />
      </Page>
    );
  }
  const data = project.data;
  if (!data) return null;

  return (
    <Page>
      <div className="flex items-start justify-between gap-4">
        <PageHead
          title={data.name}
          summary={[
            data.git ? "git" : "no git",
            plural(data.agents.length, "Agent"),
            data.skills ? plural(data.skills.length, "Skill") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          status={tildify(data.path)}
        />
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!data.exists}
            onClick={() => void window.darkMatter.openFolder(data.path)}
          >
            <FolderOpen />
            Open in Finder
          </Button>
          {data.exists && <RemoveProjectButton project={data} />}
        </div>
      </div>
      {!data.exists && <GoneBanner project={data} />}
      {data.exists && <UntrackedBanner path={data.path} />}
      <AgentPicker project={data} />
      {data.exists && <ProjectSkills path={data.path} />}
      {data.exists && <RepoSkills path={data.path} />}
      {data.exists && <ProjectMcpServers path={data.path} />}
      {data.exists && <ProjectGrant project={data} />}
      <FoundSkills project={data} />
      <FilteredActivity search={{ project: data.path }} exportName={`activity-${data.name}`} />
    </Page>
  );
}
