import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AddToProjectsDialog } from "@/components/add-to-projects";
import { PageHead } from "@/components/page-head";
import { SkillsShResults } from "@/components/skills-sh";
import { Input } from "@/components/ui/input";
import { tildify } from "@/lib/paths";

export const Route = createFileRoute("/get/skills-sh")({
  validateSearch: (search: Record<string, unknown>): { q?: string; project?: string } => ({
    ...(typeof search.q === "string" ? { q: search.q } : {}),
    ...(typeof search.project === "string" ? { project: search.project } : {}),
  }),
  component: SkillsShPage,
});

function SkillsShPage() {
  const { q = "", project } = Route.useSearch();
  return <SkillsShSearchPage key={q} initial={q} project={project ?? null} />;
}

function SkillsShSearchPage({ initial, project }: { initial: string; project: string | null }) {
  const [text, setText] = useState(initial);
  const [adding, setAdding] = useState<string[] | null>(null);
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHead
        title="skills.sh"
        summary="Search the skills.sh directory. Get Imports a Skill from its GitHub repo into the Library, pinned to a commit."
        {...(project ? { status: `Adding to ${tildify(project)} after Get.` } : {})}
      />
      <Input
        aria-label="Search skills.sh"
        placeholder="Search skills.sh, e.g. pdf or react"
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {text.trim().length < 2 && (
        <p className="text-muted-foreground text-body">Type at least 2 characters to search.</p>
      )}
      <SkillsShResults text={text} onGot={setAdding} />
      {adding && adding.length > 0 && (
        <AddToProjectsDialog
          keys={adding}
          ticked={project ? [project] : []}
          title="Add the new Skill to Projects"
          onClose={() => setAdding(null)}
        />
      )}
    </div>
  );
}
