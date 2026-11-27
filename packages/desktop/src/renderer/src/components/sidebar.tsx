import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Boxes, ChevronRight, FolderGit2, Search, Settings, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/lib/trpc";
import { relativeTime, useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { type NavItem, navSections } from "@/nav";
import { StatusDot } from "./status-dot";
import { useScan } from "./use-scan";

const rowClass =
  "no-drag flex h-9 items-center gap-3 rounded-[10px] px-2.5 font-medium text-body text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground";
/** The active row is a soft pill and its icon takes the coral accent. */
const activeRowClass =
  "bg-sidebar-accent text-sidebar-foreground hover:bg-sidebar-accent [&>svg:first-child]:text-primary";

/** Sidebar paths with a screen of their own; the rest open the placeholder screen. */
const builtPaths = new Set([
  "/inbox",
  "/library",
  "/library/collections",
  "/library/favourites",
  "/library/updates",
  "/library/trash",
  "/computer/agents",
  "/computer/activity",
  "/computer/mcp-servers",
  "/projects/suggested",
  "/get/github",
  "/get/skills-sh",
] as const);
type BuiltPath = typeof builtPaths extends Set<infer P> ? P : never;
const isBuilt = (path: string): path is BuiltPath => builtPaths.has(path as BuiltPath);

function NavLink({ path, className, children }: { path: string; className: string; children: React.ReactNode }) {
  const props = { className, activeProps: { className: activeRowClass }, activeOptions: { exact: true } };
  return isBuilt(path) ? (
    <Link to={path} {...props}>
      {children}
    </Link>
  ) : (
    <Link to="/$" params={{ _splat: path.slice(1) }} {...props}>
      {children}
    </Link>
  );
}

/** `HH:MM` in local time, as the Scheduled Scan time is set. */
const localClockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const Count = ({ value }: { value: number | undefined }) => (
  <span className="ml-auto text-muted-foreground text-meta tabular-nums">{value ?? "–"}</span>
);

/** One sidebar row per Namespace, `local` last, with its Skill count. */
const namespaceCounts = (skills: { namespace: string }[]) => {
  const counts = new Map<string, number>();
  for (const skill of skills) counts.set(skill.namespace, (counts.get(skill.namespace) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => (a === "local" ? 1 : b === "local" ? -1 : a.localeCompare(b)))
    .map(([label, count]) => ({ label, count }));
};

export function Sidebar({ connected }: { connected: boolean }) {
  const trpc = useTRPC();
  const library = useQuery(trpc.library.list.queryOptions());
  const problems = useQuery(trpc.ownedFiles.problems.queryOptions());
  const inbox = useQuery(trpc.inbox.list.queryOptions());
  const nextScan = useQuery(trpc.scheduler.status.queryOptions()).data?.nextRunAt;
  const projects = useQuery(trpc.project.list.queryOptions());
  const suggested = useQuery(trpc.project.suggested.queryOptions());
  const collections = useQuery(trpc.collections.list.queryOptions());
  const favourites = useQuery(trpc.favourites.view.queryOptions());
  const updates = useQuery(trpc.importer.updates.queryOptions());
  const { scanning, lastScanAt } = useScan();
  const now = useNow();
  const [filter, setFilter] = useState("");

  const skillCount = library.data?.skills.length;
  const counts: Record<string, number | undefined> = {
    "/inbox": inbox.data?.count,
    "/library": skillCount,
    "/library/collections": collections.data?.length,
    "/library/favourites": favourites.data?.skills.length,
  };
  /** Rows whose count is a badge: something waits on you there. */
  const badges: Record<string, number> = {
    "/inbox": inbox.data?.count ?? 0,
    "/library/updates": updates.data?.updates.length ?? 0,
  };
  const badgeIds: Record<string, string> = { "/inbox": "inbox-badge", "/library/updates": "updates-badge" };
  const sectionCounts: Record<string, number | undefined> = { Library: skillCount, Projects: projects.data?.length };
  const groupCounts: Record<string, number | undefined> = { "/projects/suggested": suggested.data?.suggested.length };
  const matches = (item: { label: string }) => item.label.toLowerCase().includes(filter.trim().toLowerCase());

  return (
    <aside className="dark flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground" data-testid="sidebar">
      <div className="drag-region flex h-[52px] shrink-0 items-center pr-4 pl-[84px]">
        <span className="font-semibold text-lead tracking-[-0.01em]">Dark Matter</span>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2.5 pt-2 pb-4">
        <div className="relative px-0.5">
          <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-3.5 text-muted-foreground" />
          <Input
            aria-label="Filter"
            className="no-drag h-8 rounded-full border-transparent bg-sidebar-accent pl-8 text-body dark:bg-sidebar-accent"
            placeholder="Filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>

        {navSections.map((section) => {
          const items = section.items.filter(matches);
          const projectRows =
            section.title === "Projects"
              ? (projects.data ?? []).map((project) => ({ ...project, label: project.name })).filter(matches)
              : [];
          const namespaceRows =
            section.title === "Library" ? namespaceCounts(library.data?.skills ?? []).filter(matches) : [];
          const collectionRows =
            section.title === "Library"
              ? (collections.data ?? [])
                  .map((collection) => ({ ...collection, label: collection.name }))
                  .filter(matches)
              : [];
          const group = section.group && matches(section.group) ? section.group : undefined;
          if (
            filter &&
            items.length === 0 &&
            projectRows.length === 0 &&
            namespaceRows.length === 0 &&
            collectionRows.length === 0 &&
            !group
          )
            return null;
          return (
            <div key={section.title ?? "top"} className="flex flex-col gap-px">
              {section.title && (
                <div className="flex h-7 items-center px-2.5 font-medium text-meta text-muted-foreground">
                  {section.title}
                  {section.title in sectionCounts && <Count value={sectionCounts[section.title]} />}
                </div>
              )}
              {items.map((item: NavItem) => (
                <NavLink key={item.path} path={item.path} className={rowClass}>
                  <item.icon className="size-4 text-muted-foreground" />
                  <span className="truncate">{item.label}</span>
                  {(badges[item.path] ?? 0) > 0 ? (
                    <span
                      data-testid={badgeIds[item.path]}
                      className="ml-auto min-w-5 rounded-full bg-primary px-1.5 text-center font-semibold text-micro text-primary-foreground leading-[18px] tabular-nums"
                    >
                      {badges[item.path]}
                    </span>
                  ) : (
                    item.path in counts && <Count value={counts[item.path]} />
                  )}
                </NavLink>
              ))}
              {collectionRows.map((collection) => (
                <Link
                  key={collection.name}
                  to="/collection"
                  search={{ name: collection.name }}
                  data-testid="sidebar-collection"
                  className={cn(rowClass, "pl-8")}
                  activeProps={{ className: activeRowClass }}
                  activeOptions={{ exact: true, includeSearch: true }}
                >
                  <span className="truncate">{collection.label}</span>
                  <Count value={collection.items.length} />
                </Link>
              ))}
              {namespaceRows.map((namespace) => (
                <Link
                  key={namespace.label}
                  to="/namespace"
                  search={{ name: namespace.label }}
                  data-testid="sidebar-namespace"
                  className={rowClass}
                  activeProps={{ className: activeRowClass }}
                  activeOptions={{ exact: true, includeSearch: true }}
                >
                  <Boxes className="size-4 text-muted-foreground" />
                  <span className="truncate font-mono text-meta">{namespace.label}</span>
                  <Count value={namespace.count} />
                </Link>
              ))}
              {projectRows.map((project) => (
                <Link
                  key={project.path}
                  to="/project"
                  search={{ path: project.path }}
                  data-testid="sidebar-project"
                  className={rowClass}
                  activeProps={{ className: activeRowClass }}
                  activeOptions={{ exact: true, includeSearch: true }}
                >
                  <FolderGit2 className="size-4 text-muted-foreground" />
                  <span className="truncate">{project.label}</span>
                  {project.exists ? (
                    <StatusDot tone="off" className="ml-auto" />
                  ) : (
                    <TriangleAlert aria-label="Folder gone" className="ml-auto size-3.5 text-status-warning" />
                  )}
                </Link>
              ))}
              {group && (
                <NavLink path={group.path} className={cn(rowClass, "text-meta text-muted-foreground")}>
                  {group.label}
                  <span className="ml-auto flex items-center gap-1 tabular-nums">
                    {(groupCounts[group.path] ?? 0) > 0 ? (
                      <span
                        data-testid="suggested-badge"
                        className="min-w-5 rounded-full bg-primary px-1.5 text-center font-semibold text-micro text-primary-foreground leading-[18px]"
                      >
                        {groupCounts[group.path]}
                      </span>
                    ) : (
                      0
                    )}
                    <ChevronRight className="size-3.5" />
                  </span>
                </NavLink>
              )}
            </div>
          );
        })}
      </nav>

      <footer className="flex h-11 shrink-0 items-center gap-2 px-4 text-muted-foreground text-meta">
        {/* Grey until the first Scan: green means up to date (visual reference). */}
        <StatusDot tone={connected && lastScanAt ? "healthy" : "off"} />
        <span data-testid="core-status">
          {!connected
            ? "Connecting to core…"
            : scanning
              ? "Scanning…"
              : lastScanAt
                ? `Scanned ${relativeTime(Date.parse(lastScanAt), now)}`
                : "Not scanned yet"}
          {connected && nextScan && ` · next ${localClockTime(nextScan)}`}
        </span>
        <Link
          to="/settings"
          aria-label="Settings"
          className="no-drag relative ml-auto rounded-full p-1.5 transition-colors hover:bg-sidebar-accent hover:text-foreground"
          activeProps={{ className: "bg-sidebar-accent text-foreground" }}
        >
          <Settings className="size-4" />
          {/* An owned file is holding an invalid hand edit: Settings explains it. */}
          {(problems.data?.length ?? 0) > 0 && (
            <StatusDot tone="warning" className="absolute top-0.5 right-0.5 size-1.5" />
          )}
        </Link>
      </footer>
    </aside>
  );
}
