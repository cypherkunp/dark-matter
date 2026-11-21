import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { History } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ActivityTimeline, ExportActivityButton, useActivity } from "@/components/activity-view";
import { PageHead } from "@/components/page-head";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type ActivitySearch,
  actionLabel,
  activityClients,
  clientLabel,
  knownActions,
  parseActivitySearch,
  toActivityFilter,
} from "@/lib/activity";
import { tildify } from "@/lib/paths";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/computer/activity")({
  validateSearch: parseActivitySearch,
  component: Activity,
});

/** A change to the filters; `undefined` clears one. */
type SearchPatch = { [K in keyof ActivitySearch]?: ActivitySearch[K] | undefined };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const selectClass = "h-8 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30";

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <select
      aria-label={label}
      className={selectClass}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || undefined)}
    >
      <option value="">{`Any ${label.toLowerCase()}`}</option>
      {/* A value from a link that isn't in the list still shows as chosen. */}
      {value && !options.some((option) => option.value === value) && <option value={value}>{value}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** The search field updates the URL as you type, after a short pause. */
function SearchField({ value, onChange }: { value: string; onChange: (value: string | undefined) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft || undefined), 200);
    return () => clearTimeout(timer);
  }, [draft, value, onChange]);
  return (
    <Input
      type="search"
      aria-label="Search Activity"
      placeholder="Search actions, names, files, errors…"
      className="w-72"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

function Filters({ search, set }: { search: ActivitySearch; set: (patch: SearchPatch) => void }) {
  const trpc = useTRPC();
  const skills = useQuery(trpc.library.list.queryOptions()).data?.skills ?? [];
  const projects = useQuery(trpc.project.list.queryOptions()).data ?? [];
  const filtered = Object.keys(search).length > 0;
  return (
    <div data-testid="activity-filters" className="flex flex-wrap items-center gap-2">
      <SearchField value={search.q ?? ""} onChange={(q) => set({ q })} />
      <FilterSelect
        label="Action"
        value={search.action}
        options={knownActions.map((action) => ({ value: action, label: actionLabel(action) }))}
        onChange={(action) => set({ action })}
      />
      <FilterSelect
        label="Client"
        value={search.client}
        options={activityClients.map((client) => ({ value: client, label: clientLabel(client) }))}
        onChange={(client) => set({ client: activityClients.find((known) => known === client) })}
      />
      <FilterSelect
        label="Skill"
        value={search.skill}
        options={skills.map((skill) => ({ value: skill.key, label: skill.key }))}
        onChange={(skill) => set({ skill })}
      />
      <FilterSelect
        label="Project"
        value={search.project}
        options={projects.map((project) => ({ value: project.path, label: tildify(project.path) }))}
        onChange={(project) => set({ project })}
      />
      <label className="flex h-8 items-center gap-2 px-1 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={search.failures ?? false}
          onChange={(event) => set({ failures: event.target.checked || undefined })}
        />
        Failures only
      </label>
      <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
        From
        <input
          type="date"
          aria-label="From"
          className={selectClass}
          value={search.from ?? ""}
          onChange={(event) => set({ from: event.target.value || undefined })}
        />
      </label>
      <label className="flex items-center gap-1.5 text-muted-foreground text-xs">
        To
        <input
          type="date"
          aria-label="To"
          className={selectClass}
          value={search.to ?? ""}
          onChange={(event) => set({ to: event.target.value || undefined })}
        />
      </label>
      {filtered && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => set(Object.fromEntries(Object.keys(search).map((key) => [key, undefined])))}
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}

function Activity() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const filter = toActivityFilter(search);
  const activity = useActivity(filter);
  const entries = activity.data?.entries ?? [];
  const failures = entries.filter((entry) => entry.result === "error").length;
  const filtered = Object.keys(search).length > 0;
  const set = useCallback(
    (patch: SearchPatch) =>
      navigate({ search: (current) => parseActivitySearch({ ...current, ...patch }), replace: true }),
    [navigate],
  );

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-6 px-10 py-9">
      <div className="flex items-start justify-between gap-4">
        <PageHead
          title="Activity"
          summary={`${entries.length} ${filtered ? "matching " : ""}${entries.length === 1 ? "entry" : "entries"} · ${plural(failures, "failure")}`}
          status="Everything Dark Matter did, and which client asked for it"
        />
        {entries.length > 0 && <ExportActivityButton filter={filter} name="dark-matter-activity" />}
      </div>
      <Filters search={search} set={set} />
      {activity.isPending ? null : entries.length === 0 ? (
        <section
          data-testid="activity-empty"
          className="flex flex-col items-center gap-3 rounded-xl border px-6 py-16 text-center"
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <History className="size-5 text-muted-foreground" />
          </div>
          <h2 className="font-semibold text-base">{filtered ? "Nothing matches" : "No Activity yet"}</h2>
          <p className="max-w-sm text-muted-foreground text-sm">
            {filtered ? "Try fewer filters." : "Every change Dark Matter makes is recorded here."}
          </p>
        </section>
      ) : (
        <ActivityTimeline entries={entries} className="flex-1" />
      )}
    </div>
  );
}
