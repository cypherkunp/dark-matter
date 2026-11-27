import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { useScan } from "@/components/use-scan";
import { useTRPC } from "@/lib/trpc";
import { relativeTime, useNow } from "@/lib/use-now";
import { breadcrumbFor } from "@/nav";

export function Header() {
  const trpc = useTRPC();
  const library = useQuery(trpc.library.list.queryOptions());
  const now = useNow();
  const { scan, scanning } = useScan();
  const location = useLocation();
  const crumbs = breadcrumbFor(location.pathname, location.search);

  return (
    <header className="dark drag-region flex h-[52px] shrink-0 items-center gap-3 px-4 text-foreground">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-body">
        {crumbs.map((crumb, index) => (
          <Fragment key={`${index}:${crumb}`}>
            {index > 0 && <ChevronRight className="size-3.5 text-muted-foreground/70" />}
            <span className={index === crumbs.length - 1 ? "font-medium" : "text-muted-foreground"}>{crumb}</span>
          </Fragment>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-3">
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
