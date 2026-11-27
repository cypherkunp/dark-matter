import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Layers } from "lucide-react";
import { useState } from "react";
import { openList, openRow } from "@/components/list";
import { Page } from "@/components/page";
import { PageHead } from "@/components/page-head";
import { plural } from "@/components/skill-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/library_/collections")({ component: CollectionsView });

/** Collections (#36): named, flat lists of Library Skills you add to a Project in one go. */
function CollectionsView() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const collections = useQuery(trpc.collections.list.queryOptions());
  const [name, setName] = useState("");
  const create = useMutation(
    trpc.collections.create.mutationOptions({
      onSuccess: (created) => {
        setName("");
        void navigate({ to: "/collection", search: { name: created.name } });
      },
    }),
  );
  const list = collections.data ?? [];

  return (
    <Page>
      <PageHead
        title="Collections"
        summary={`${plural(list.length, "Collection")} · templates: adding one creates ordinary Project Skills, and later edits don't touch those Projects`}
      />
      <form
        className="flex max-w-md gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) create.mutate({ name });
        }}
      >
        <Input
          aria-label="New Collection name"
          placeholder="New Collection, e.g. frontend kit"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          Create
        </Button>
      </form>
      {create.error && <p className="text-body text-status-warning">{create.error.message}</p>}
      {collections.isPending ? null : list.length === 0 ? (
        <section
          data-testid="collections-empty"
          className="flex flex-col items-center gap-3 rounded-2xl bg-foreground/[0.025] px-6 py-16 text-center"
        >
          <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Layers className="size-5" />
          </div>
          <h2 className="font-semibold text-heading">No Collections yet</h2>
          <p className="max-w-sm text-muted-foreground text-body">
            Group Library Skills you often use together, like a frontend kit, and add them to a Project in one go.
          </p>
        </section>
      ) : (
        <div className={openList}>
          {list.map((collection) => (
            <Link
              key={collection.name}
              to="/collection"
              search={{ name: collection.name }}
              data-testid="collection-row"
              className={cn("flex min-h-16 items-center gap-3 py-3", openRow)}
            >
              <Layers className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-body">{collection.name}</div>
                <div className="truncate text-muted-foreground text-meta">
                  {collection.items.map((item) => item.name).join(", ") || "Empty"}
                </div>
              </div>
              <span className="text-muted-foreground text-meta tabular-nums">
                {plural(collection.items.length, "Skill")}
              </span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </Link>
          ))}
        </div>
      )}
    </Page>
  );
}
