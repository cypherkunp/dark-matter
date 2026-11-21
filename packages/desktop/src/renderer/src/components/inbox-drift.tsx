import type { DriftFinding, InboxDriftGroup } from "@dark-matter/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";

/** What drifted, in a sentence (#42). */
const describe = (finding: DriftFinding): string => {
  const mode = finding.mode === "copy" ? "Copy" : "Link";
  switch (finding.kind) {
    case "missing":
      return `${mode} deleted on disk`;
    case "replaced":
      return `${mode} replaced by something else (e.g. npx skills)`;
    case "lockAdded":
      return "A teammate added it to skills-lock.json: add it as a Copy?";
    case "lockRemoved":
      return "A teammate removed it from skills-lock.json: remove the Copy?";
    case "projectGone":
      return "The Project's folder is gone";
  }
};

/** Button labels per kind: Restore re-applies intent, Accept makes projects.json match disk. */
const acceptLabel: Record<DriftFinding["kind"], string> = {
  missing: "Accept (turn Off)",
  replaced: "Accept (forget)",
  lockAdded: "Add as Copy",
  lockRemoved: "Remove Copy",
  projectGone: "Remove Project",
};

function DriftRow({ finding }: { finding: DriftFinding }) {
  const trpc = useTRPC();
  const ignore = useMutation(trpc.inbox.ignore.mutationOptions());
  const restore = useMutation(trpc.drift.restore.mutationOptions());
  const accept = useMutation(trpc.drift.accept.mutationOptions());
  const busy = ignore.isPending || restore.isPending || accept.isPending;
  const error = restore.error ?? accept.error;
  return (
    <div data-testid="inbox-drift-finding" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <StatusDot tone="warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium text-sm">{finding.name ?? finding.project}</span>
        <p className="text-muted-foreground text-xs">{describe(finding)}</p>
        {finding.paths.length > 0 && (
          <div className="truncate font-mono text-muted-foreground text-xs">{finding.paths.join(" · ")}</div>
        )}
        {error && <p className="text-destructive text-xs">{error.message}</p>}
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => ignore.mutate({ id: finding.id })}>
          Ignore
        </Button>
        {finding.actions.includes("accept") && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => accept.mutate({ id: finding.id })}>
            {acceptLabel[finding.kind]}
          </Button>
        )}
        {finding.actions.includes("restore") && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => restore.mutate({ id: finding.id })}>
            Restore
          </Button>
        )}
      </div>
    </div>
  );
}

/** Drift between `projects.json` and the disk, by Project, with Restore or Accept (#42). */
export function InboxDrift({ groups }: { groups: InboxDriftGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <>
      <div className="flex flex-col gap-1 pt-2">
        <h2 className="font-semibold text-base">Drift</h2>
        <p className="text-muted-foreground text-sm">
          A Project's files no longer match what Dark Matter delivered. Restore puts them back; Accept updates the
          Project to match the disk.
        </p>
      </div>
      {groups.map((group) => (
        <section key={group.project} data-testid="inbox-drift-group" className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 font-semibold text-sm">
            <Link to="/project" search={{ path: group.project }} className="hover:underline">
              {group.name}
            </Link>
            <span className="font-normal text-muted-foreground text-xs tabular-nums">{group.findings.length}</span>
          </h2>
          <div className="divide-y rounded-xl border">
            {group.findings.map((finding) => (
              <DriftRow key={finding.id} finding={finding} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
