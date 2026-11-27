import { Dialog } from "@base-ui/react/dialog";
import type { CollectionItem, CollectionItemView } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { AddToProjectsDialog } from "@/components/add-to-projects";
import { ConfirmDialog } from "@/components/copy-actions";
import { openList, openRow } from "@/components/list";
import { Page } from "@/components/page";
import { PageHead } from "@/components/page-head";
import { plural } from "@/components/skill-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/collection")({
  validateSearch: (search: Record<string, unknown>): { name: string; add?: boolean } => ({
    name: typeof search.name === "string" ? search.name : "",
    // ⌘K "Add <Collection> to Projects…" opens the grid straight away.
    ...(search.add === true || search.add === "true" ? { add: true } : {}),
  }),
  component: CollectionView,
});

/** An item's identity within its Collection. */
const itemId = (item: CollectionItem | CollectionItemView) =>
  item.kind === "skill" ? `skill:${item.key}` : `mcpServer:${item.name}`;

/** What `setItems` stores for an item as Collections list it. */
const stored = (item: CollectionItemView): CollectionItem =>
  item.kind === "skill" ? { kind: "skill", key: item.key } : { kind: "mcpServer", name: item.name };

/** One Collection: its Skills and MCP Servers (edit, remove), Rename, Delete and + Add to Projects. */
function CollectionView() {
  const { name, add } = Route.useSearch();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const collections = useQuery(trpc.collections.list.queryOptions());
  const collection = collections.data?.find((found) => found.name === name);
  const [dialog, setDialog] = useState<"add" | "addServers" | "rename" | "delete" | "projects" | null>(null);
  useEffect(() => {
    if (!add) return;
    setDialog("projects");
    void navigate({ to: "/collection", search: { name }, replace: true });
  }, [add, name, navigate]);
  const setItems = useMutation(trpc.collections.setItems.mutationOptions());
  const remove = useMutation(
    trpc.collections.delete.mutationOptions({ onSuccess: () => void navigate({ to: "/library/collections" }) }),
  );
  const items = collection?.items ?? [];
  const save = (next: CollectionItem[]) => setItems.mutate({ name, items: next });
  const keys = items.flatMap((item) => (item.kind === "skill" && !item.missing ? [item.key] : []));
  const servers = items.flatMap((item) => (item.kind === "mcpServer" && !item.missing ? [item.name] : []));
  const skillItems = items.filter((item) => item.kind === "skill");
  const serverItems = items.filter((item) => item.kind === "mcpServer");
  const removeItem = (item: CollectionItemView) =>
    save(items.filter((other) => itemId(other) !== itemId(item)).map(stored));

  if (collections.isPending) return null;
  if (!collection)
    return (
      <Page className="gap-4">
        <PageHead title={name} summary="No Collection has this name." />
        <Link to="/library/collections" className="text-body hover:underline">
          All Collections
        </Link>
      </Page>
    );

  return (
    <Page>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <PageHead
            title={name}
            summary={`${plural(skillItems.length, "Skill")}${
              serverItems.length > 0 ? `, ${plural(serverItems.length, "MCP Server")}` : ""
            } · a template: editing it later doesn't change Projects that used it`}
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => setDialog("rename")}>
          Rename
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDialog("delete")}>
          Delete
        </Button>
        <Button size="sm" disabled={keys.length + servers.length === 0} onClick={() => setDialog("projects")}>
          + Add to Projects
        </Button>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center">
          <h2 className="font-semibold text-section">Skills</h2>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setDialog("add")}>
            Add Skills
          </Button>
        </div>
        {skillItems.length === 0 ? (
          <p data-testid="collection-empty" className="text-muted-foreground text-body">
            No Skills yet. Add some from the Library.
          </p>
        ) : (
          <div className={openList}>
            {skillItems.map((item) => (
              <div
                key={item.key}
                data-testid="collection-item"
                className={cn("flex min-h-16 items-center gap-3 py-3", openRow)}
              >
                <div className="min-w-0 flex-1">
                  {item.missing ? (
                    <div className="text-body">{item.name}</div>
                  ) : (
                    <Link to="/skill" search={{ key: item.key }} className="text-body hover:underline">
                      {item.name}
                    </Link>
                  )}
                  <div className="font-mono text-micro text-muted-foreground">{item.key}</div>
                </div>
                {item.missing && (
                  <span className="rounded-full border border-warning-border bg-warning-surface px-2 py-0.5 text-status-warning text-meta">
                    Not in the Library
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${item.name} from ${name}`}
                  onClick={() => removeItem(item)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {setItems.error && <p className="text-body text-status-warning">{setItems.error.message}</p>}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center">
          <h2 className="font-semibold text-section">MCP Servers</h2>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setDialog("addServers")}>
            Add MCP Servers
          </Button>
        </div>
        {serverItems.length === 0 ? (
          <p className="text-muted-foreground text-body">No MCP Servers yet. Add some from the Library.</p>
        ) : (
          <div className={openList}>
            {serverItems.map((item) => (
              <div
                key={item.name}
                data-testid="collection-server"
                className={cn("flex min-h-14 items-center gap-3 py-3", openRow)}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-body">{item.name}</div>
                  <div className="text-micro text-muted-foreground">MCP Server · Personal by default</div>
                </div>
                {item.missing && (
                  <span className="rounded-full border border-warning-border bg-warning-surface px-2 py-0.5 text-status-warning text-meta">
                    Not in the Library
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${item.name} from ${name}`}
                  onClick={() => removeItem(item)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {dialog === "add" && (
        <AddSkillsToCollection
          added={keys}
          onAdd={(added) => {
            save([...items.map(stored), ...added.map((key) => ({ kind: "skill" as const, key }))]);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "addServers" && (
        <AddServersToCollection
          added={serverItems.map((item) => item.name)}
          onAdd={(added) => {
            save([...items.map(stored), ...added.map((server) => ({ kind: "mcpServer" as const, name: server }))]);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "rename" && (
        <RenameCollectionDialog
          name={name}
          onRenamed={(to) => {
            setDialog(null);
            void navigate({ to: "/collection", search: { name: to }, replace: true });
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title={`Delete ${name}?`}
          confirm="Delete Collection"
          busy={remove.isPending}
          error={remove.error?.message}
          onConfirm={() => remove.mutate({ name })}
          onClose={() => setDialog(null)}
        >
          <p>
            Projects that used it keep their Project Skills and Project MCP Servers. Its Library Skills and MCP Servers
            stay in the Library.
          </p>
        </ConfirmDialog>
      )}
      {dialog === "projects" && (
        <AddToProjectsDialog
          keys={keys}
          servers={servers}
          collection={name}
          title={`Add ${name} to Projects`}
          description="Each ticked Skill becomes an ordinary Project Skill: Link (the default) is a personal symlink, excluded from git; Copy is committed for your team. Each ticked MCP Server becomes a Personal Project MCP Server, never committed. Name Conflicts are marked per item."
          onClose={() => setDialog(null)}
        />
      )}
    </Page>
  );
}

function AddSkillsToCollection({
  added,
  onAdd,
  onClose,
}: {
  added: string[];
  onAdd: (keys: string[]) => void;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const library = useQuery(trpc.library.list.queryOptions());
  const [picked, setPicked] = useState<string[]>([]);
  const candidates = (library.data?.skills ?? []).filter((skill) => !added.includes(skill.key));
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(36rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-heading">Add Skills to the Collection</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-body">Pick Library Skills.</Dialog.Description>
          {candidates.length === 0 ? (
            <p className="text-muted-foreground text-body">Every Library Skill is already in this Collection.</p>
          ) : (
            <div className="min-h-0 divide-y overflow-y-auto rounded-xl border">
              {candidates.map((skill) => (
                <label
                  key={skill.key}
                  data-testid="collection-skill-option"
                  className="flex cursor-pointer items-center gap-3 px-4 py-2.5"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={picked.includes(skill.key)}
                    onChange={(event) =>
                      setPicked((current) =>
                        event.target.checked ? [...current, skill.key] : current.filter((key) => key !== skill.key),
                      )
                    }
                  />
                  <span className="text-body">{skill.name}</span>
                  <span className="font-mono text-micro text-muted-foreground">{skill.key}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
            <Button disabled={picked.length === 0} onClick={() => onAdd(picked)}>
              Add {plural(picked.length, "Skill")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AddServersToCollection({
  added,
  onAdd,
  onClose,
}: {
  added: string[];
  onAdd: (names: string[]) => void;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const library = useQuery(trpc.mcp.list.queryOptions());
  const [picked, setPicked] = useState<string[]>([]);
  const candidates = (library.data?.servers ?? []).filter(
    (server) => server.definition && !added.includes(server.name),
  );
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(36rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-heading">Add MCP Servers to the Collection</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-body">Pick Library MCP Servers.</Dialog.Description>
          {candidates.length === 0 ? (
            <p className="text-muted-foreground text-body">No other Library MCP Servers to add.</p>
          ) : (
            <div className="min-h-0 divide-y overflow-y-auto rounded-xl border">
              {candidates.map((server) => (
                <label
                  key={server.name}
                  data-testid="collection-server-option"
                  className="flex cursor-pointer items-center gap-3 px-4 py-2.5"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={picked.includes(server.name)}
                    onChange={(event) =>
                      setPicked((current) =>
                        event.target.checked
                          ? [...current, server.name]
                          : current.filter((other) => other !== server.name),
                      )
                    }
                  />
                  <span className="font-mono text-body">{server.name}</span>
                  <span className="text-micro text-muted-foreground">{server.definition?.transport}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
            <Button disabled={picked.length === 0} onClick={() => onAdd(picked)}>
              Add {plural(picked.length, "MCP Server")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RenameCollectionDialog({
  name,
  onRenamed,
  onClose,
}: {
  name: string;
  onRenamed: (to: string) => void;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const [to, setTo] = useState(name);
  const rename = useMutation(trpc.collections.rename.mutationOptions({ onSuccess: (done) => onRenamed(done.name) }));
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex w-[min(30rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-heading">Rename Collection</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-body">
            Projects that used it aren't affected.
          </Dialog.Description>
          <Input aria-label="Collection name" value={to} onChange={(event) => setTo(event.target.value)} />
          {rename.error && <p className="text-body text-status-warning">{rename.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
            <Button
              disabled={!to.trim() || to.trim() === name || rename.isPending}
              onClick={() => rename.mutate({ name, newName: to })}
            >
              Rename
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
