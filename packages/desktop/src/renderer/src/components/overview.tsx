import type { Overview as OverviewData, StatCard } from "@dark-matter/contracts";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { StatusDot, type StatusTone } from "@/components/status-dot";
import { useTRPC } from "@/lib/trpc";
import { relativeTime, useNow } from "@/lib/use-now";

/** Core paths are router paths (hash history), so a plain link opens the screen that resolves it. */
const href = (path: string) => `#${path}`;

const cards: {
  id: keyof OverviewData["stats"];
  label: string;
  caption: string;
  tone: (count: number) => StatusTone;
}[] = [
  { id: "projectSkillsOn", label: "Project Skills On", caption: "delivered to Projects", tone: () => "on" },
  {
    id: "globalSkills",
    label: "Global Skills found",
    caption: "in Agents' global folders",
    tone: (count) => (count > 0 ? "warning" : "healthy"),
  },
  {
    id: "outdated",
    label: "Outdated",
    caption: "updates and Copies behind",
    tone: (count) => (count > 0 ? "warning" : "healthy"),
  },
  {
    id: "nameConflicts",
    label: "Name Conflicts",
    caption: "waiting on Resolve",
    tone: (count) => (count > 0 ? "warning" : "healthy"),
  },
];

function Card({ label, caption, card, tone }: { label: string; caption: string; card: StatCard; tone: StatusTone }) {
  return (
    <a
      href={href(card.path)}
      data-testid="stat-card"
      className="flex flex-col gap-2 px-5 py-4 transition-colors hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03] focus-visible:outline-none"
    >
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="flex items-center gap-2 font-semibold text-[26px] leading-none tracking-[-0.02em] tabular-nums">
        {card.count !== null && <StatusDot tone={tone} />}
        <span data-testid="stat-count">{card.count ?? "–"}</span>
      </span>
      <span className="text-muted-foreground text-xs">{card.count === null ? "after the first Scan" : caption}</span>
    </a>
  );
}

/**
 * The overview strip (#45): stat cards, then the amber alerts panel for Inbox
 * items and drift. Both come from one core call and refresh through `events`.
 */
export function Overview() {
  const trpc = useTRPC();
  const overview = useQuery(trpc.overview.get.queryOptions());
  const now = useNow();
  if (!overview.data) return null;
  const { stats, alerts } = overview.data;

  return (
    <div className="flex flex-col gap-8">
      <section
        aria-label="Overview"
        className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-2xl border bg-muted md:grid-cols-4 md:divide-y-0"
      >
        {cards.map((card) => (
          <Card
            key={card.id}
            label={card.label}
            caption={card.caption}
            card={stats[card.id]}
            tone={card.tone(stats[card.id].count ?? 0)}
          />
        ))}
      </section>
      {alerts.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 font-semibold text-sm">
            Active alerts{" "}
            <span className="font-normal text-muted-foreground text-xs tabular-nums">{alerts.length}</span>
          </h2>
          <div className="flex flex-col divide-y divide-warning-border overflow-hidden rounded-2xl border border-warning-border bg-warning-surface">
            {alerts.map((alert) => (
              <a
                key={alert.id}
                href={href(alert.path)}
                data-testid="overview-alert"
                className="flex items-start gap-3 px-5 py-4 hover:bg-warning-border/20"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="text-sm">
                    <span className="font-semibold">{alert.subject}</span> {alert.issue}
                  </p>
                  <p className="truncate text-muted-foreground text-sm">{alert.detail}</p>
                  <p className="text-muted-foreground text-xs">
                    First observed {relativeTime(Date.parse(alert.firstSeenAt), now)}
                  </p>
                </div>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
