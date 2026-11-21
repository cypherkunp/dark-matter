import { Tabs } from "@base-ui/react/tabs";
import type { SkillDetail } from "@dark-matter/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FolderOpen, Trash2 } from "lucide-react";
import { useState } from "react";
import { DeleteSkillDialog } from "@/components/delete-skill-dialog";
import { ModifiedBadge } from "@/components/modified-badge";
import { skillTabs } from "@/components/skill-tabs";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";

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
  return (
    <div className="flex items-start gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h1 className="flex items-center gap-2 font-semibold text-2xl tracking-tight">
          {skill.name}
          {skill.modified && <ModifiedBadge />}
        </h1>
        <p data-testid="skill-provenance-line" className="flex flex-wrap items-center gap-2 text-sm">
          <Link
            to="/namespace"
            search={{ name: skill.namespace }}
            className="rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            {skill.namespace}
          </Link>
          <span className="truncate font-mono text-muted-foreground text-xs">{provenanceLine(skill)}</span>
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={() => void window.darkMatter.openFolder(skill.path)}>
        <FolderOpen />
        Reveal in Finder
      </Button>
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
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-10 py-9">
      {skill.error ? (
        <p className="text-muted-foreground text-sm">{skill.error.message}</p>
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
                  className="-mb-px border-transparent border-b-2 px-3 py-2 text-muted-foreground text-sm data-[active]:border-foreground data-[active]:font-medium data-[active]:text-foreground"
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
    </div>
  );
}
