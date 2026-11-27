import { Tabs } from "@base-ui/react/tabs";
import type { SkillDetail } from "@dark-matter/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { AddToProjectsDialog } from "@/components/add-to-projects";
import { DeleteSkillDialog } from "@/components/delete-skill-dialog";
import { StarSkillButton } from "@/components/favourites";
import { ModifiedBadge } from "@/components/modified-badge";
import { Page } from "@/components/page";
import { skillTabs } from "@/components/skill-tabs";
import { Button } from "@/components/ui/button";
import { chipClass } from "@/components/ui/chip";
import { CheckUpstreamButton, OrphanedBadge } from "@/components/updates";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/skill")({
  validateSearch: (search: Record<string, unknown>): { key: string; tab?: string } => ({
    key: typeof search.key === "string" ? search.key : "",
    ...(typeof search.tab === "string" && { tab: search.tab }),
  }),
  component: SkillPage,
});

/** Namespace, then the Source and its commit, or the Local Source path. */
const provenanceLine = ({ entry }: SkillDetail) => {
  if (entry.localSource) return `Local Source ${entry.localSource}`;
  const commit = entry.commit ? `commit ${entry.commit.slice(0, 7)}` : null;
  return [entry.source, commit].filter(Boolean).join(" · ");
};

function SkillHeader({ skill }: { skill: SkillDetail }) {
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex items-start gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h1 className="flex items-center gap-2 font-bold text-display">
          <StarSkillButton skillKey={skill.key} />
          {skill.name}
          {skill.modified && <ModifiedBadge />}
          {skill.entry.orphaned && <OrphanedBadge reason={skill.entry.orphaned} />}
        </h1>
        <p data-testid="skill-provenance-line" className="flex flex-wrap items-center gap-2 text-body">
          <Link
            to="/namespace"
            search={{ name: skill.namespace }}
            className={cn(chipClass({ mono: true }), "hover:text-foreground")}
          >
            {skill.namespace}
          </Link>
          <span className="truncate font-mono text-muted-foreground text-meta">{provenanceLine(skill)}</span>
        </p>
      </div>
      <CheckUpstreamButton skill={skill} />
      <Button size="sm" variant="outline" onClick={() => void window.darkMatter.openFolder(skill.path)}>
        <FolderOpen />
        Reveal in Finder
      </Button>
      <Button size="sm" onClick={() => setAdding(true)}>
        <Plus />
        Add to Projects
      </Button>
      {adding && <AddToProjectsDialog keys={[skill.key]} onClose={() => setAdding(false)} />}
      <Button size="sm" variant="outline" onClick={() => setDeleting(true)}>
        <Trash2 />
        Delete
      </Button>
      <DeleteSkillDialog
        skillKey={skill.key}
        open={deleting}
        onClose={() => setDeleting(false)}
        onDeleted={() => void navigate({ to: "/library" })}
      />
    </div>
  );
}

function SkillPage() {
  const { key, tab } = Route.useSearch();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const skill = useQuery({ ...trpc.skill.get.queryOptions({ key }), enabled: key !== "" });
  const current = skillTabs.find((candidate) => candidate.id === tab) ?? skillTabs[0];

  return (
    <Page className="gap-6">
      {skill.error ? (
        <p className="text-muted-foreground text-body">{skill.error.message}</p>
      ) : skill.data && current ? (
        <>
          <SkillHeader skill={skill.data} />
          <Tabs.Root
            value={current.id}
            onValueChange={(value) => navigate({ to: "/skill", search: { key, tab: String(value) }, replace: true })}
            className="flex flex-col gap-5"
          >
            <Tabs.List className="flex gap-1 border-b">
              {skillTabs.map((item) => (
                <Tabs.Tab
                  key={item.id}
                  value={item.id}
                  className="-mb-px border-transparent border-b-2 px-3 py-2 text-muted-foreground text-body data-[active]:border-foreground data-[active]:font-medium data-[active]:text-foreground"
                >
                  {item.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <Tabs.Panel value={current.id}>
              <current.Panel skill={skill.data} />
            </Tabs.Panel>
          </Tabs.Root>
        </>
      ) : null}
    </Page>
  );
}
