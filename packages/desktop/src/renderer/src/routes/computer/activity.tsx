import type { ActivityEntry } from "@dark-matter/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { History } from "lucide-react";
import { PageHead } from "@/components/page-head";
import { StatusDot } from "@/components/status-dot";
import { actionLabel, clientLabel, groupByDay } from "@/lib/activity";
import { useTRPC } from "@/lib/trpc";
import { useNow } from "@/lib/use-now";

export const Route = createFileRoute("/computer/activity")({ component: Activity });

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function Entry({ entry }: { entry: ActivityEntry }) {
  const failed = entry.result === "error";
  const subjects = entry.subjects.map((subject) => subject.id).join(", ");
  return (
    <div data-testid="activity-entry" className="flex min-h-16 items-start gap-3 px-5 py-3">
      <StatusDot tone={failed ? "warning" : "healthy"} className="mt-1.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{actionLabel(entry.action)}</span>
          {failed && (
            <span className="rounded-md bg-warning-surface px-1.5 py-0.5 text-[11px] text-status-warning">failed</span>
          )}
        </div>
        <div className="truncate font-mono text-muted-foreground text-xs">
          {[subjects, ...entry.filesWritten].filter(Boolean).join(" · ") || entry.action}
        </div>
        {entry.error && <div className="text-muted-foreground text-xs">{entry.error.message}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-muted-foreground text-xs">
        <span className="rounded-md border px-1.5 py-0.5 font-mono text-[11px]">{clientLabel(entry.client)}</span>
        <time dateTime={entry.time} className="w-12 text-right tabular-nums">
          {new Date(entry.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </time>
      </div>
    </div>
  );
}

function Activity() {
  const trpc = useTRPC();
  const activity = useQuery(trpc.activity.list.queryOptions({}));
  const now = useNow(60_000);
  const entries = activity.data?.entries ?? [];
  const days = groupByDay(entries, new Date(now));
  const failures = entries.filter((entry) => entry.result === "error").length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <PageHead
        title="Activity"
        summary={`${plural(entries.length, "change")} · ${plural(failures, "failure")}`}
        status="Everything Dark Matter did, and which client asked for it"
      />
      {activity.isPending ? null : entries.length === 0 ? (
        <section
          data-testid="activity-empty"
          className="flex flex-col items-center gap-3 rounded-xl border px-6 py-16 text-center"
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <History className="size-5 text-muted-foreground" />
          </div>
          <h2 className="font-semibold text-base">No Activity yet</h2>
          <p className="max-w-sm text-muted-foreground text-sm">Every change Dark Matter makes is recorded here.</p>
        </section>
      ) : (
        days.map((day) => (
          <section key={day.key} data-testid="activity-day" className="flex flex-col gap-3">
            <h2 className="flex items-baseline gap-2 font-semibold text-sm">
              {day.label}
              <span className="font-normal text-muted-foreground text-xs tabular-nums">{day.entries.length}</span>
            </h2>
            <div className="divide-y rounded-xl border">
              {day.entries.map((entry) => (
                <Entry key={entry.id} entry={entry} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
