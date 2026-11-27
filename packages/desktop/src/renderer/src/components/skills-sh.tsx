import type { SkillsShListing } from "@dark-matter/contracts";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useFavourites } from "@/components/favourites";
import { markdownComponents } from "@/components/skill-preview";
import { Button } from "@/components/ui/button";
import { chipClass } from "@/components/ui/chip";
import { useTRPC } from "@/lib/trpc";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

/** Wait this long after the last keystroke before searching; the core also keeps within 30 searches a minute. */
const DEBOUNCE_MS = 350;

const useDebounced = <T,>(value: T, ms: number): T => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
};

/** skills.sh results for `text`, searched once typing pauses. Under 2 characters searches nothing. */
export const useSkillsShSearch = (text: string) => {
  const trpc = useTRPC();
  const query = useDebounced(text.trim(), DEBOUNCE_MS);
  return useQuery({
    ...trpc.skillsSh.search.queryOptions({ query }),
    enabled: query.length >= 2,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
};

const installs = (count: number) =>
  `${new Intl.NumberFormat(undefined, { notation: "compact" }).format(count)} install${count === 1 ? "" : "s"}`;

/** SKILL.md without its frontmatter. */
const bodyOf = (skillMd: string) => skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

/** The friendly side of skills.sh's 30-a-minute limit. */
function RateLimitNotice({ until }: { until: string }) {
  const now = useNow(1000);
  const seconds = Math.max(0, Math.ceil((Date.parse(until) - now) / 1000));
  return (
    <p data-testid="skills-sh-rate-limited" className="text-muted-foreground text-body">
      skills.sh allows 30 searches a minute, so Dark Matter is pausing for a moment.
      {seconds > 0 ? ` Search again in ${seconds} s.` : " Search again now."}
    </p>
  );
}

/** Preview: the listing's SKILL.md, from its repo (the GitHub Import preview; nothing is written). */
function ListingPreview({ listing }: { listing: SkillsShListing }) {
  const trpc = useTRPC();
  const preview = useQuery({
    ...trpc.importer.preview.queryOptions({ input: listing.url }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const skill = preview.data?.skills.find((candidate) => candidate.selected);
  return (
    <div data-testid="skills-sh-preview" className="border-t bg-muted/30 px-6 py-3 text-body">
      {preview.isPending && <p className="text-muted-foreground">Loading…</p>}
      {preview.error && <p className="text-status-warning">{preview.error.message}</p>}
      {preview.data && !skill && <p className="text-muted-foreground">This Skill isn't in its repo any more.</p>}
      {skill && (
        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {bodyOf(skill.skillMd)}
        </Markdown>
      )}
    </div>
  );
}

/** One listing: name, Source, installs, then Preview and Get (or "in Library"). */
function ListingRow({ listing, onGot }: { listing: SkillsShListing; onGot: (keys: string[]) => void }) {
  const trpc = useTRPC();
  const { isSourceStarred } = useFavourites();
  const [open, setOpen] = useState(false);
  const get = useMutation(
    trpc.skillsSh.get.mutationOptions({ onSuccess: (result) => onGot(result.skills.map((skill) => skill.key)) }),
  );
  return (
    <div data-testid="skills-sh-result" className="flex flex-col">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium text-body">{listing.name}</span>
          <span className="truncate font-mono text-micro text-muted-foreground">
            {isSourceStarred(listing.source) && (
              <span data-testid="favourite-source" title="Favourite Source" className="text-status-warning">
                ★{" "}
              </span>
            )}
            {listing.source} · {installs(listing.installs)}
          </span>
          {get.error && <span className="text-status-warning text-meta">{get.error.message}</span>}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
          {open ? <ChevronDown /> : <ChevronRight />}
          Preview
        </Button>
        {listing.key ? (
          <Link to="/skill" search={{ key: listing.key }} className={cn(chipClass(), "hover:bg-foreground/10")}>
            in Library
          </Link>
        ) : (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Get ${listing.name}`}
            disabled={get.isPending}
            onClick={() => get.mutate({ id: listing.id })}
          >
            <Download />
            {get.isPending ? "Getting…" : "Get"}
          </Button>
        )}
      </div>
      {open && <ListingPreview listing={listing} />}
    </div>
  );
}

/**
 * skills.sh results for what's typed (#31). Get Imports the listing's Skill
 * through GitHub Import; `onGot` receives the Library keys (e.g. to offer
 * Add to Projects).
 */
export function SkillsShResults({ text, onGot }: { text: string; onGot: (keys: string[]) => void }) {
  const search = useSkillsShSearch(text);
  if (text.trim().length < 2) return null;
  const data = search.data;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {search.error && <p className="text-body text-status-warning">{search.error.message}</p>}
      {data?.rateLimitedUntil && <RateLimitNotice until={data.rateLimitedUntil} />}
      {search.isPending && !data && <p className="text-muted-foreground text-body">Searching skills.sh…</p>}
      {data && !data.rateLimitedUntil && data.skills.length === 0 && (
        <p className="text-muted-foreground text-body">Nothing on skills.sh matches “{data.query}”.</p>
      )}
      {data && data.skills.length > 0 && (
        <div className="min-h-0 divide-y overflow-y-auto rounded-xl border">
          {data.skills.map((listing) => (
            <ListingRow key={listing.id} listing={listing} onGot={onGot} />
          ))}
        </div>
      )}
    </div>
  );
}
