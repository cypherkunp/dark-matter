import { createFileRoute } from "@tanstack/react-router";
import { GitHubImport } from "@/components/github-import";
import { Page } from "@/components/page";
import { PageHead } from "@/components/page-head";
import { tildify } from "@/lib/paths";

export const Route = createFileRoute("/get/github")({
  validateSearch: (search: Record<string, unknown>): { url?: string; project?: string } => ({
    ...(typeof search.url === "string" ? { url: search.url } : {}),
    ...(typeof search.project === "string" ? { project: search.project } : {}),
  }),
  component: GitHubImportPage,
});

function GitHubImportPage() {
  const { url = "", project } = Route.useSearch();
  return (
    <Page className="gap-6">
      <PageHead
        title="GitHub import"
        summary="Import Skills from a GitHub repo into the Library, pinned to a commit and following its branch or tag."
        {...(project ? { status: `Adding to ${tildify(project)} after the Import.` } : {})}
      />
      <GitHubImport key={`${url}\n${project ?? ""}`} initialUrl={url} project={project ?? null} />
    </Page>
  );
}
