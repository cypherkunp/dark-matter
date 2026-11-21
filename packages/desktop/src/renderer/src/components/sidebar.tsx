import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Orbit, Search, Settings } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { tildify } from "@/lib/paths";
import { useTRPC } from "@/lib/trpc";
import { relativeTime, useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { type NavItem, navSections } from "@/nav";
import { StatusDot } from "./status-dot";
import { useScan } from "./use-scan";

const rowClass =
  "no-drag flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-sidebar-foreground hover:bg-sidebar-accent/60";
const activeRowClass = "bg-sidebar-accent font-medium hover:bg-sidebar-accent";

/** Sidebar paths with a screen of their own; the rest open the placeholder screen. */
const builtPaths = new Set(["/inbox", "/library", "/computer/agents", "/computer/activity"] as const);
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

const Count = ({ value }: { value: number | undefined }) => (
  <span className="ml-auto text-muted-foreground text-xs tabular-nums">{value ?? "–"}</span>
);

export function Sidebar({ connected }: { connected: boolean }) {
  const trpc = useTRPC();
  const info = useQuery(trpc.core.info.queryOptions());
  const library = useQuery(trpc.library.list.queryOptions());
  const problems = useQuery(trpc.ownedFiles.problems.queryOptions());
  const inbox = useQuery(trpc.inbox.list.queryOptions());
  const { scanning, lastScanAt } = useScan();
  const now = useNow();
  const [filter, setFilter] = useState("");

  const skillCount = library.data?.skills.length;
  const counts: Record<string, number | undefined> = { "/inbox": inbox.data?.count, "/library": skillCount };
  const sectionCounts: Record<string, number | undefined> = { Library: skillCount, Projects: 0 };
  const matches = (item: { label: string }) => item.label.toLowerCase().includes(filter.trim().toLowerCase());

  return (
    <aside className="flex w-64 shrink-0 flex-col border-sidebar-border border-r bg-sidebar" data-testid="sidebar">
      <div className="drag-region flex h-[52px] shrink-0 items-center gap-2.5 pr-4 pl-[84px]">
        <div className="flex size-7 items-center justify-center rounded-lg bg-foreground text-background">
          <Orbit className="size-4" />
        </div>
        <div className="min-w-0 leading-tight">
          <div className="font-semibold text-[13px]">Dark Matter</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {info.data ? `${tildify(info.data.libraryHome)} · ${skillCount ?? 0} Skills` : "Starting core…"}
          </div>
        </div>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2.5 pt-2 pb-4">
        <div className="relative px-0.5">
          <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-3.5 text-muted-foreground" />
          <Input
            aria-label="Filter"
            className="no-drag h-8 bg-background pl-8 text-[13px]"
            placeholder="Filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>

        {navSections.map((section) => {
          const items = section.items.filter(matches);
          const group = section.group && matches(section.group) ? section.group : undefined;
          if (filter && items.length === 0 && !group) return null;
          return (
            <div key={section.title ?? "top"} className="flex flex-col gap-px">
              {section.title && (
                <div className="flex h-7 items-center px-2.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                  {section.title}
                  {section.title in sectionCounts && <Count value={sectionCounts[section.title]} />}
                </div>
              )}
              {items.map((item: NavItem) => (
                <NavLink key={item.path} path={item.path} className={rowClass}>
                  <item.icon className="size-4 text-muted-foreground" />
                  <span className="truncate">{item.label}</span>
                  {item.path === "/inbox" && (counts[item.path] ?? 0) > 0 ? (
                    <span
                      data-testid="inbox-badge"
                      className="ml-auto rounded-full border border-warning-border bg-warning-surface px-1.5 text-[11px] text-status-warning tabular-nums"
                    >
                      {counts[item.path]}
                    </span>
                  ) : (
                    item.path in counts && <Count value={counts[item.path]} />
                  )}
                </NavLink>
              ))}
              {group && (
                <NavLink
                  path={group.path}
                  className={cn(rowClass, "text-[11px] text-muted-foreground uppercase tracking-wide")}
                >
                  {group.label}
                  <span className="ml-auto flex items-center gap-1 tabular-nums">
                    0 <ChevronRight className="size-3.5" />
                  </span>
                </NavLink>
              )}
            </div>
          );
        })}
      </nav>

      <footer className="flex h-10 shrink-0 items-center gap-2 border-sidebar-border border-t px-4 text-muted-foreground text-xs">
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
        </span>
        <Link
          to="/settings"
          aria-label="Settings"
          className="no-drag relative ml-auto rounded-md p-1 hover:bg-sidebar-accent/60 hover:text-foreground"
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
