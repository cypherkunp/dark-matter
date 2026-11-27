import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { PageHead } from "@/components/page-head";
import { plural } from "@/components/skill-list";
import { Button } from "@/components/ui/button";
import { UpdatesList, useCheckUpdates } from "@/components/updates";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/library_/updates")({ component: UpdatesView });

/** When the Sources were last checked, and GitHub's rate limit then. */
const statusLine = (checkedAt: string | undefined, remaining: number | undefined, auth: string | undefined) =>
  [
    checkedAt ? `Checked ${new Date(checkedAt).toLocaleString()}` : "Not checked yet",
    remaining !== undefined && `${remaining} GitHub requests left`,
    auth && `GitHub: ${auth === "gh" ? "gh login" : auth === "pat" ? "token" : "anonymous"}`,
  ]
    .filter(Boolean)
    .join(" · ");

/** Updates (#33): checked per Source in the Scheduled Scan and from here; always applied by you. */
function UpdatesView() {
  const trpc = useTRPC();
  const view = useQuery(trpc.importer.updates.queryOptions());
  const check = useCheckUpdates();
  const failed = view.data?.sources.filter((source) => source.error) ?? [];
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <PageHead
            title="Updates"
            summary={`${plural(view.data?.updates.length ?? 0, "update")} · ${plural(view.data?.sources.length ?? 0, "Source")}`}
            status={statusLine(
              view.data?.github?.checkedAt,
              view.data?.github?.rateLimit?.remaining,
              view.data?.github?.auth,
            )}
          />
        </div>
        <Button size="sm" disabled={check.isPending} onClick={() => check.mutate({})}>
          <RefreshCw />
          {check.isPending ? "Checking…" : "Check for updates"}
        </Button>
      </div>
      {check.isError && <p className="text-body text-status-warning">{check.error.message}</p>}
      {failed.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-xl border border-warning-border bg-warning-surface px-5 py-3 text-meta">
          {failed.map((source) => (
            <li key={`${source.source}@${source.ref}`}>
              <span className="font-mono">
                {source.source}@{source.ref}
              </span>{" "}
              {source.error}
            </li>
          ))}
        </ul>
      )}
      <UpdatesList />
    </div>
  );
}
