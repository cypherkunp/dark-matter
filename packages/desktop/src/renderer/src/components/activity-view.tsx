import type { ActivityEntry, ActivityFilter, ActivitySubject } from "@dark-matter/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Download } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import {
  type ActivitySearch,
  actionLabel,
  groupByDay,
  requesterLabel,
  saveJson,
  subjectLink,
  toActivityFilter,
} from "@/lib/activity";
import { tildify } from "@/lib/paths";
import { useTRPC } from "@/lib/trpc";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/** The newest entries a view loads; the export has them all. */
const VIEW_LIMIT = 5_000;

/** The Activity entries matching `filter`, newest first. Viewing is never recorded. */
export const useActivity = (filter: ActivityFilter) => {
  const trpc = useTRPC();
  return useQuery(trpc.activity.list.queryOptions({ ...filter, limit: VIEW_LIMIT }));
};

const subjectName = (subject: ActivitySubject) => (subject.kind === "project" ? tildify(subject.id) : subject.id);

function SubjectLinks({ subjects }: { subjects: ActivitySubject[] }) {
  return subjects.map((subject, index) => {
    const link = subjectLink(subject);
    return (
      <span key={`${subject.kind}:${subject.id}`}>
        {index > 0 && " · "}
        {link ? (
          <Link {...link} data-testid="activity-subject" className="hover:text-foreground hover:underline">
            {subjectName(subject)}
          </Link>
        ) : (
          subjectName(subject)
        )}
      </span>
    );
  });
}

function Detail({ entry }: { entry: ActivityEntry }) {
  const rows: [string, React.ReactNode][] = [
    ["time", new Date(entry.time).toLocaleString()],
    ["client", requesterLabel(entry)],
    ["action", entry.action],
  ];
  return (
    <div data-testid="activity-detail" className="flex flex-col gap-3 pt-2 pb-1 text-xs">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground">Files written</span>
        {entry.filesWritten.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <ul data-testid="activity-files" className="flex flex-col gap-0.5 font-mono">
            {entry.filesWritten.map((file) => (
              <li key={file} className="break-all">
                {file}
              </li>
            ))}
          </ul>
        )}
      </div>
      {entry.error && (
        <div
          data-testid="activity-error"
          className="flex flex-col gap-0.5 rounded-lg border border-warning-border bg-warning-surface px-3 py-2"
        >
          {entry.error.tag && <span className="font-mono font-semibold text-status-warning">{entry.error.tag}</span>}
          <span className="whitespace-pre-wrap break-words">{entry.error.message}</span>
        </div>
      )}
    </div>
  );
}

function Entry({ entry, expanded, onToggle }: { entry: ActivityEntry; expanded: boolean; onToggle: () => void }) {
  const failed = entry.result === "error";
  return (
    <div className="flex items-start gap-3 px-5 py-3">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} details`}
        onClick={onToggle}
        className="mt-0.5 rounded-md text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-4 transition-transform", expanded && "rotate-90")} />
      </button>
      <StatusDot tone={failed ? "warning" : "healthy"} className="mt-1.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onToggle} className="text-left font-medium text-sm">
            {actionLabel(entry.action)}
          </button>
          {failed && (
            <span className="rounded-md bg-warning-surface px-1.5 py-0.5 text-[11px] text-status-warning">failed</span>
          )}
        </div>
        <div className="truncate font-mono text-muted-foreground text-xs">
          {entry.subjects.length > 0 ? <SubjectLinks subjects={entry.subjects} /> : entry.action}
        </div>
        {!expanded && entry.error && (
          <div className="truncate text-muted-foreground text-xs">{entry.error.message}</div>
        )}
        {expanded && <Detail entry={entry} />}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-muted-foreground text-xs">
        <span className="rounded-md border px-1.5 py-0.5 font-mono text-[11px]">{requesterLabel(entry)}</span>
        <time dateTime={entry.time} className="w-12 text-right tabular-nums">
          {new Date(entry.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </time>
      </div>
    </div>
  );
}

type Item = { type: "day"; key: string; label: string; count: number } | { type: "entry"; entry: ActivityEntry };

/**
 * The Activity timeline: entries grouped by local day, virtualized in its own
 * scroll box (size it with `className`). Rows expand to show the files
 * written and the error, and names link to their pages.
 */
export function ActivityTimeline({ entries, className }: { entries: ActivityEntry[]; className?: string }) {
  const now = useNow(60_000);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const items = useMemo<Item[]>(
    () =>
      groupByDay(entries, new Date(now)).flatMap((day) => [
        { type: "day" as const, key: day.key, label: day.label, count: day.entries.length },
        ...day.entries.map((entry) => ({ type: "entry" as const, entry })),
      ]),
    [entries, now],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (items[index]?.type === "day" ? 36 : 64),
    getItemKey: (index) => {
      const item = items[index];
      return item?.type === "day" ? `day:${item.key}` : (item?.entry.id ?? index);
    },
    overscan: 8,
  });
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div
      ref={scrollRef}
      data-testid="activity-timeline"
      className={cn("min-h-0 overflow-y-auto rounded-xl border", className)}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index];
          if (!item) return null;
          return (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full border-b last:border-b-0"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {item.type === "day" ? (
                <h2
                  data-testid="activity-day"
                  className="flex items-baseline gap-2 bg-muted/40 px-5 py-2 font-semibold text-xs"
                >
                  {item.label}
                  <span className="font-normal text-muted-foreground tabular-nums">{item.count}</span>
                </h2>
              ) : (
                <div data-testid="activity-entry">
                  <Entry
                    entry={item.entry}
                    expanded={expanded.has(item.entry.id)}
                    onToggle={() => toggle(item.entry.id)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Saves every entry matching `filter` (not just the loaded ones) as a JSON file. */
export function ExportActivityButton({ filter, name }: { filter: ActivityFilter; name: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const exported = await queryClient.fetchQuery({ ...trpc.activity.export.queryOptions(filter), staleTime: 0 });
          saveJson(exported, `${name}-${exported.exportedAt.slice(0, 10)}.json`);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Download />
      Export JSON
    </Button>
  );
}

/**
 * A filtered Activity view for another page (the Skill page's Provenance tab,
 * the Project page): the timeline for `search`, its export, and a link to
 * the same view on the Activity screen.
 */
export function FilteredActivity({ search, exportName }: { search: ActivitySearch; exportName: string }) {
  const filter = toActivityFilter(search);
  const activity = useActivity(filter);
  const entries = activity.data?.entries ?? [];
  return (
    <section data-testid="filtered-activity" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold text-sm">Activity</h2>
        <span className="text-muted-foreground text-xs tabular-nums">{entries.length}</span>
        <div className="ml-auto flex items-center gap-2">
          <Link
            to="/computer/activity"
            search={search}
            className="text-muted-foreground text-xs hover:text-foreground hover:underline"
          >
            Open in Activity
          </Link>
          {entries.length > 0 && <ExportActivityButton filter={filter} name={exportName} />}
        </div>
      </div>
      {activity.isPending ? null : entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing recorded yet.</p>
      ) : (
        <ActivityTimeline entries={entries} className="max-h-[28rem]" />
      )}
    </section>
  );
}
