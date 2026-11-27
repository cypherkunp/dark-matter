import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { ChevronRight, RefreshCw, Search } from "lucide-react";
import { Fragment } from "react";
import { openCommandPalette } from "@/components/command-palette";
import { Button } from "@/components/ui/button";
import { useScan } from "@/components/use-scan";
import { useTRPC } from "@/lib/trpc";
import { relativeTime, useNow } from "@/lib/use-now";
import { breadcrumbFor } from "@/nav";

/** Screens whose breadcrumb says more than their title does. */
const detailPaths = new Set(["/skill", "/namespace", "/collection", "/project"]);
const shortcut = navigator.userAgent.includes("Mac") ? "⌘K" : "Ctrl K";

export function Header() {
  const trpc = useTRPC();
  const library = useQuery(trpc.library.list.queryOptions());
  const now = useNow();
  const { scan, scanning } = useScan();
  const location = useLocation();
  const crumbs = breadcrumbFor(location.pathname, location.search);

  return (
    <header className="dark drag-region grid h-[52px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 text-foreground">
      <div className="min-w-0">
        {detailPaths.has(location.pathname) && (
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 truncate text-body">
            {crumbs.map((crumb, index) => (
              <Fragment key={`${index}:${crumb}`}>
                {index > 0 && <ChevronRight className="size-3.5 text-muted-foreground/70" />}
                <span className={index === crumbs.length - 1 ? "font-medium" : "text-muted-foreground"}>{crumb}</span>
              </Fragment>
            ))}
          </nav>
        )}
      </div>
      <button
        type="button"
        onClick={openCommandPalette}
        className="no-drag flex h-8 w-[min(26rem,40vw)] items-center gap-2 rounded-full bg-white/[0.07] px-3 text-body text-muted-foreground transition-colors hover:bg-white/[0.11] hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="truncate">Search Skills, Projects and actions…</span>
        <kbd className="ml-auto rounded-md bg-white/[0.08] px-1.5 font-sans text-micro">{shortcut}</kbd>
      </button>
      <div className="flex items-center gap-3 justify-self-end">
        {library.dataUpdatedAt > 0 && (
          <span className="text-muted-foreground text-meta">Updated {relativeTime(library.dataUpdatedAt, now)}</span>
        )}
        <Button size="sm" className="no-drag px-3.5" disabled={scanning} onClick={scan}>
          <RefreshCw className={scanning ? "animate-spin motion-reduce:animate-none" : undefined} />
          {scanning ? "Scanning…" : "Scan now"}
        </Button>
      </div>
    </header>
  );
}
