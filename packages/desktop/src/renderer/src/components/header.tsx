import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
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
  const crumbs = breadcrumbFor(useLocation({ select: (location) => location.pathname }));

  return (
    <header className="drag-region flex h-[52px] shrink-0 items-center gap-3 border-b px-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px]">
        {crumbs.map((crumb, index) => (
          <Fragment key={crumb}>
            {index > 0 && <ChevronRight className="size-3.5 text-muted-foreground" />}
            <span className={index === crumbs.length - 1 ? "font-medium" : "text-muted-foreground"}>{crumb}</span>
          </Fragment>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        {library.dataUpdatedAt > 0 && (
          <span className="text-muted-foreground text-xs">Updated {relativeTime(library.dataUpdatedAt, now)}</span>
        )}
        <Button size="sm" className="no-drag" disabled={scanning} onClick={scan}>
          {scanning ? "Scanning…" : "Scan now"}
        </Button>
      </div>
    </header>
  );
}
