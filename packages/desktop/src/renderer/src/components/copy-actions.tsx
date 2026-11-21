import { Dialog } from "@base-ui/react/dialog";
import type { ProjectSkill } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";

const warningPill = "rounded-md border border-warning-border bg-warning-surface px-1.5 py-0.5 text-[11px]";

/** "outdated" or "modified in repo" for a Copy. ("Modified" is kept for a Library Skill.) */
export function CopyStateBadge({ skill }: { skill: ProjectSkill }) {
  if (skill.copyState === "outdated")
    return (
      <span data-testid="copy-state" className={warningPill}>
        outdated
      </span>
    );
  if (skill.copyState === "modifiedInRepo")
    return (
      <span data-testid="copy-state" className={warningPill}>
        modified in repo
      </span>
    );
  return null;
}

/** A modal that asks before a change; `onConfirm` runs it. */
export function ConfirmDialog({
  title,
  children,
  confirm,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirm: string;
  busy: boolean;
  error?: string | undefined;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex w-[min(30rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-lg">{title}</Dialog.Title>
          <Dialog.Description render={<div />} className="flex flex-col gap-2 text-muted-foreground text-sm">
            {children}
          </Dialog.Description>
          {error && <p className="text-sm text-status-warning">{error}</p>}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
            <Button disabled={busy} onClick={onConfirm}>
              {confirm}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DiffDialog({ path, skill, onClose }: { path: string; skill: ProjectSkill; onClose: () => void }) {
  const trpc = useTRPC();
  const diff = useQuery(trpc.project.copyDiff.queryOptions({ path, key: skill.key }));
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(48rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-lg">{skill.name}: repo vs Library</Dialog.Title>
          <pre
            data-testid="copy-diff"
            className="min-h-0 overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px] leading-relaxed"
          >
            {diff.data ? diff.data.patch || "No differences." : diff.error ? diff.error.message : "Loading…"}
          </pre>
          <div className="flex justify-end">
            <Dialog.Close render={<Button variant="outline" />}>Close</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Update (outdated), or Diff, Pull into Library and Take Library version (modified in repo). */
export function CopyActions({ path, skill }: { path: string; skill: ProjectSkill }) {
  const trpc = useTRPC();
  const update = useMutation(trpc.project.updateCopy.mutationOptions({ onSuccess: () => setAsking(false) }));
  const pull = useMutation(trpc.project.pullCopy.mutationOptions());
  const [diffing, setDiffing] = useState(false);
  const [asking, setAsking] = useState(false);
  const busy = update.isPending || pull.isPending;
  if (skill.copyState === "outdated")
    return (
      <Button size="sm" variant="outline" disabled={busy} onClick={() => update.mutate({ path, key: skill.key })}>
        Update
      </Button>
    );
  if (skill.copyState !== "modifiedInRepo") return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setDiffing(true)}>
        Diff
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => pull.mutate({ path, key: skill.key })}>
        Pull into Library
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(true)}>
        Take Library version
      </Button>
      {pull.error && <p className="text-status-warning text-xs">{pull.error.message}</p>}
      {diffing && <DiffDialog path={path} skill={skill} onClose={() => setDiffing(false)} />}
      {asking && (
        <ConfirmDialog
          title={`Replace ${skill.name} with the Library version?`}
          confirm="Take Library version"
          busy={update.isPending}
          error={update.error?.message}
          onConfirm={() => update.mutate({ path, key: skill.key, discardEdits: true })}
          onClose={() => setAsking(false)}
        >
          <p>The edits made in this repo will be overwritten. git will show the change for you to commit.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * On/Off for a Project Skill. Turning a Copy Off (or removing it) is a team
 * change, so it asks first: its committed files and lock entry are deleted.
 */
export function useProjectSkillChanges(path: string, skill: ProjectSkill) {
  const trpc = useTRPC();
  const setOn = useMutation(trpc.project.setSkillOn.mutationOptions({ onSuccess: () => setAsking(null) }));
  const remove = useMutation(trpc.project.removeSkill.mutationOptions({ onSuccess: () => setAsking(null) }));
  const [asking, setAsking] = useState<"off" | "remove" | null>(null);
  const isCopy = skill.mode === "copy" && skill.on;
  const discardEdits = skill.copyState === "modifiedInRepo";
  const run = (change: "off" | "remove") =>
    change === "off"
      ? setOn.mutate({ path, key: skill.key, on: false, discardEdits })
      : remove.mutate({ path, key: skill.key, discardEdits });
  const toggle = (on: boolean) => {
    if (on) setOn.mutate({ path, key: skill.key, on: true });
    else if (isCopy) setAsking("off");
    else run("off");
  };
  const removeSkill = () => (isCopy ? setAsking("remove") : run("remove"));
  const dialog = asking && (
    <ConfirmDialog
      title={asking === "off" ? `Turn the Copy of ${skill.name} Off?` : `Remove the Copy of ${skill.name}?`}
      confirm={asking === "off" ? "Turn Off" : "Remove"}
      busy={setOn.isPending || remove.isPending}
      error={(setOn.error ?? remove.error)?.message}
      onConfirm={() => run(asking)}
      onClose={() => setAsking(null)}
    >
      <p>
        This deletes the committed files at <code className="font-mono text-xs">{skill.paths.join(", ")}</code> and its{" "}
        <code className="font-mono text-xs">skills-lock.json</code> entry. git will show the deletion for you to commit,
        and teammates lose it when they pull.
      </p>
      {discardEdits && (
        <p className="text-status-warning">Its files were modified in repo: those edits will be lost.</p>
      )}
    </ConfirmDialog>
  );
  return {
    toggle,
    removeSkill,
    dialog,
    busy: setOn.isPending || remove.isPending,
    error: asking ? null : (setOn.error ?? remove.error),
  };
}

/**
 * Resolve a Name Conflict by keeping `skill`. When a Skill it removes is a
 * Copy modified in repo, the core refuses, and this asks before discarding the edits.
 */
export function useResolveConflict(path: string, skill: ProjectSkill) {
  const trpc = useTRPC();
  const [asking, setAsking] = useState(false);
  const resolve = useMutation(
    trpc.project.resolveConflict.mutationOptions({
      onSuccess: () => setAsking(false),
      onError: (error) => {
        if ((error.data as { tag?: string } | undefined)?.tag === "CopyModifiedInRepo") setAsking(true);
      },
    }),
  );
  const dialog = asking && (
    <ConfirmDialog
      title={`Keep ${skill.key} and discard the edits?`}
      confirm="Discard edits and resolve"
      busy={resolve.isPending}
      onConfirm={() => resolve.mutate({ path, key: skill.key, discardEdits: true })}
      onClose={() => setAsking(false)}
    >
      <p>
        Resolving removes {skill.conflictsWith.join(", ")}. One of them is a Copy whose files were modified in repo:
        those edits will be lost, and git will show the deletion for you to commit.
      </p>
    </ConfirmDialog>
  );
  return {
    resolve: () => resolve.mutate({ path, key: skill.key }),
    dialog,
    busy: resolve.isPending,
    error: asking ? null : resolve.error,
  };
}
