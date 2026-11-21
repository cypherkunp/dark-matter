import { useMutation, useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/** What's starred (#35): Library Skills by key, Sources as `owner/repo`. */
export const useFavourites = () => {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.favourites.get.queryOptions());
  const sources = new Set((data?.sources ?? []).map((source) => source.toLowerCase()));
  const skills = new Set(data?.skills ?? []);
  return {
    isSkillStarred: (key: string) => skills.has(key),
    isSourceStarred: (source: string) => sources.has(source.toLowerCase()),
  };
};

/** A GitHub Source a Namespace names: `owner/repo`. */
export const sourceOfNamespace = (namespace: string) => (/^[^/]+\/[^/]+$/.test(namespace) ? namespace : null);

const starClass = (starred: boolean) =>
  cn("size-4", starred ? "fill-status-warning text-status-warning" : "text-muted-foreground");

/** The Favourite star on a Skill row or a Skill page. */
export function StarSkillButton({ skillKey, className }: { skillKey: string; className?: string }) {
  const trpc = useTRPC();
  const { isSkillStarred } = useFavourites();
  const star = useMutation(trpc.favourites.setSkill.mutationOptions());
  const starred = isSkillStarred(skillKey);
  return (
    <button
      type="button"
      data-testid="star-skill"
      aria-label={starred ? "Unstar Skill" : "Star Skill"}
      aria-pressed={starred}
      disabled={star.isPending}
      onClick={() => star.mutate({ key: skillKey, starred: !starred })}
      className={cn("no-drag rounded-md p-1 hover:bg-muted", className)}
    >
      <Star className={starClass(starred)} />
    </button>
  );
}

/** Favourite Source: on the Namespace view and the GitHub import screen. */
export function StarSourceButton({ source }: { source: string }) {
  const trpc = useTRPC();
  const { isSourceStarred } = useFavourites();
  const star = useMutation(trpc.favourites.setSource.mutationOptions());
  const starred = isSourceStarred(source);
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid="star-source"
      aria-pressed={starred}
      disabled={star.isPending}
      onClick={() => star.mutate({ source, starred: !starred })}
    >
      <Star className={starClass(starred)} />
      {starred ? "Favourite Source" : "Favourite this Source"}
    </Button>
  );
}
