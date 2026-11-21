import { Dialog } from "@base-ui/react/dialog";
import type { CollectionItem } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useState } from "react";
import { AddToProjectsDialog } from "@/components/add-to-projects";
import { ConfirmDialog } from "@/components/copy-actions";
import { PageHead } from "@/components/page-head";
import { plural } from "@/components/skill-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/collection")({
  validateSearch: (search: Record<string, unknown>): { name: string } => ({
    name: typeof search.name === "string" ? search.name : "",
  }),
  component: CollectionView,
});

/** One Collection: its Skills (edit, remove), Rename, Delete and + Add to Projects. */
function CollectionView() {
  const { name } = Route.useSearch();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const collections = useQuery(trpc.collections.list.queryOptions());
  const collection = collections.data?.find((found) => found.name === name);
  const [dialog, setDialog] = useState<"add" | "rename" | "delete" | "projects" | null>(null);
  const setItems = useMutation(trpc.collections.setItems.mutationOptions());
  const remove = useMutation(
    trpc.collections.delete.mutationOptions({ onSuccess: () => void navigate({ to: "/library/collections" }) }),
  );
  const items = collection?.items ?? [];
  const save = (next: CollectionItem[]) => setItems.mutate({ name, items: next });
  const keys = items.flatMap((item) => (item.kind === "skill" && !item.missing ? [item.key] : []));

  if (collections.isPending) return null;
  if (!collection)
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-10 py-9">
        <PageHead title={name} summary="No Collection has this name." />
        <Link to="/library/collections" className="text-sm hover:underline">
          All Collections
        </Link>
      </div>
    );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <PageHead
            title={name}
            summary={`${plural(items.length, "Skill")} · a template: editing it later doesn't change Projects that used it`}
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => setDialog("rename")}>
          Rename
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDialog("delete")}>
          Delete
        </Button>
        <Button size="sm" disabled={keys.length === 0} onClick={() => setDialog("projects")}>
          + Add to Projects
        </Button>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center">
          <h2 className="font-semibold text-sm">Skills</h2>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setDialog("add")}>
            Add Skills
          </Button>
        </div>
        {items.length === 0 ? (
          <p data-testid="collection-empty" className="text-muted-foreground text-sm">
            No Skills yet. Add some from the Library.
          </p>
        ) : (
          <div className="divide-y rounded-xl border">
            {items.map((item) => (
              <div key={item.key} data-testid="collection-item" className="flex min-h-16 items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  {item.missing ? (
                    <div className="text-sm">{item.name}</div>
                  ) : (
                    <Link to="/skill" search={{ key: item.key }} className="text-sm hover:underline">
                      {item.name}
                    </Link>
                  )}
                  <div className="font-mono text-[11px] text-muted-foreground">{item.key}</div>
                </div>
                {item.missing && (
                  <span className="rounded-full border border-warning-border bg-warning-surface px-2 py-0.5 text-status-warning text-xs">
                    Not in the Library
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${item.name} from ${name}`}
                  onClick={() => save(items.filter((other) => other.key !== item.key))}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {setItems.error && <p className="text-sm text-status-warning">{setItems.error.message}</p>}
      </section>

      {dialog === "add" && (
        <AddSkillsToCollection
          added={items.map((item) => item.key)}
          onAdd={(added) => {
            save([...items, ...added.map((key) => ({ kind: "skill" as const, key }))]);
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
          <p>Projects that used it keep their Project Skills. Its Library Skills stay in the Library.</p>
        </ConfirmDialog>
      )}
      {dialog === "projects" && (
        <AddToProjectsDialog
          keys={keys}
          collection={name}
          title={`Add ${name} to Projects`}
          description="Each ticked Skill becomes an ordinary Project Skill. Link (the default) is a personal symlink, excluded from git; Copy is committed for your team. Name Conflicts are marked per Skill."
          onClose={() => setDialog(null)}
        />
      )}
    </div>
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
          <Dialog.Title className="font-semibold text-lg">Add Skills to the Collection</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-sm">Pick Library Skills.</Dialog.Description>
          {candidates.length === 0 ? (
            <p className="text-muted-foreground text-sm">Every Library Skill is already in this Collection.</p>
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
                  <span className="text-sm">{skill.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{skill.key}</span>
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
          <Dialog.Title className="font-semibold text-lg">Rename Collection</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-sm">
            Projects that used it aren't affected.
          </Dialog.Description>
          <Input aria-label="Collection name" value={to} onChange={(event) => setTo(event.target.value)} />
          {rename.error && <p className="text-sm text-status-warning">{rename.error.message}</p>}
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
