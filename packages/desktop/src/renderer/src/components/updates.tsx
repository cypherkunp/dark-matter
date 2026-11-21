import type { SkillDetail, SkillUpdate, UpdateChoice } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/lib/trpc";
import { ModifiedBadge } from "./modified-badge";

/** Orphaned (#33): its Source is gone; the Library copy is kept as is. */
export function OrphanedBadge({ reason }: { reason?: string }) {
  return (
    <span
      data-testid="orphaned-badge"
      title={reason ?? "Its Source can't be found any more: kept as is until you Detach or re-point it"}
      className="rounded-full bg-warning-surface px-2 py-0.5 font-medium text-[11px] text-status-warning"
    >
      Orphaned
    </span>
  );
}

/** Check for updates: every Source, or only those of `keys`. Nothing is ever applied. */
export const useCheckUpdates = () => {
  const trpc = useTRPC();
  return useMutation(trpc.importer.checkUpdates.mutationOptions());
};

/** The Skill page's Check upstream: checks this Skill's Source and says what it found. */
export function CheckUpstreamButton({ skill }: { skill: SkillDetail }) {
  const check = useCheckUpdates();
  if (skill.entry.sourceType !== "github" || skill.entry.localSource) return null;
  const found = check.data?.updates.some((update) => update.key === skill.key);
  const orphaned = check.data?.orphaned.some((orphan) => orphan.key === skill.key);
  const pinned = skill.entry.refType === "tag";
  return (
    <div className="flex items-center gap-2">
      {check.isSuccess && (
        <span data-testid="check-upstream-result" className="text-muted-foreground text-xs">
          {orphaned ? (
            "Source gone"
          ) : found ? (
            <Link to="/library/updates" className="text-foreground underline">
              Update available
            </Link>
          ) : pinned ? (
            `Pinned to ${skill.entry.ref}`
          ) : (
            "Up to date"
          )}
        </span>
      )}
      {check.isError && <span className="text-destructive text-xs">{check.error.message}</span>}
      <Button
        size="sm"
        variant="outline"
        disabled={check.isPending}
        onClick={() => check.mutate({ keys: [skill.key] })}
      >
        <RefreshCw />
        {check.isPending ? "Checking…" : "Check upstream"}
      </Button>
    </div>
  );
}

function UpdateRow({ update }: { update: SkillUpdate }) {
  const trpc = useTRPC();
  const [showDiff, setShowDiff] = useState(false);
  const diff = useQuery({ ...trpc.importer.updateDiff.queryOptions({ key: update.key }), enabled: showDiff });
  const apply = useMutation(trpc.importer.applyUpdates.mutationOptions());
  const choose = (choice?: UpdateChoice) => apply.mutate({ updates: [{ key: update.key, ...(choice && { choice }) }] });
  return (
    <div data-testid="update-row" className="flex flex-col gap-2 px-5 py-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Link to="/skill" search={{ key: update.key }} className="font-medium text-sm hover:underline">
              {update.key}
            </Link>
            {update.modified && <ModifiedBadge />}
          </div>
          <div className="truncate font-mono text-muted-foreground text-xs">
            {update.source}@{update.ref} · {update.commit?.slice(0, 7) ?? "?"} → {update.head.slice(0, 7)}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setShowDiff(!showDiff)}>
          {showDiff ? "Hide diff" : "Diff"}
        </Button>
        {update.modified ? (
          <>
            <Button size="sm" disabled={apply.isPending} onClick={() => choose("takeUpstream")}>
              Take upstream
            </Button>
            <Button size="sm" variant="outline" disabled={apply.isPending} onClick={() => choose("keepMine")}>
              Keep mine
            </Button>
            <Button size="sm" variant="outline" disabled={apply.isPending} onClick={() => choose("detach")}>
              Detach
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={apply.isPending} onClick={() => choose()}>
            Update
          </Button>
        )}
      </div>
      {update.modified && (
        <p className="text-muted-foreground text-xs">
          You changed this Skill. Take upstream puts your version in trash, Keep mine skips this version, Detach makes
          it a local Skill that never updates.
        </p>
      )}
      {apply.isError && <p className="text-destructive text-xs">{apply.error.message}</p>}
      {showDiff && (
        <pre data-testid="update-diff" className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
          {diff.isPending ? "Loading…" : diff.isError ? diff.error.message : diff.data.patch || "No changes"}
        </pre>
      )}
    </div>
  );
}

function OrphanedRow({ skillKey, reason }: { skillKey: string; reason: string }) {
  const trpc = useTRPC();
  const [input, setInput] = useState("");
  const detach = useMutation(trpc.importer.detach.mutationOptions());
  const repoint = useMutation(trpc.importer.repoint.mutationOptions({ onSuccess: () => setInput("") }));
  const error = detach.error ?? repoint.error;
  return (
    <div data-testid="orphaned-row" className="flex flex-col gap-2 px-5 py-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Link to="/skill" search={{ key: skillKey }} className="font-medium text-sm hover:underline">
              {skillKey}
            </Link>
            <OrphanedBadge reason={reason} />
          </div>
          <div className="truncate text-muted-foreground text-xs">{reason}</div>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={detach.isPending}
          onClick={() => detach.mutate({ key: skillKey })}
        >
          Detach
        </Button>
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim()) repoint.mutate({ key: skillKey, input });
        }}
      >
        <Input
          aria-label={`Re-point ${skillKey}`}
          placeholder="owner/repo or a GitHub tree URL"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="h-7 font-mono text-xs"
        />
        <Button size="sm" variant="outline" type="submit" disabled={repoint.isPending || !input.trim()}>
          Re-point
        </Button>
      </form>
      {error && <p className="text-destructive text-xs">{error.message}</p>}
    </div>
  );
}

/** The Updates list (#33): each changed Skill with a diff, applied per Skill or with Update all. */
export function UpdatesList() {
  const trpc = useTRPC();
  const view = useQuery(trpc.importer.updates.queryOptions());
  const apply = useMutation(trpc.importer.applyUpdates.mutationOptions());
  const updates = view.data?.updates ?? [];
  const orphaned = view.data?.orphaned ?? [];
  const plain = updates.filter((update) => !update.modified);
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 font-semibold text-sm">
          Updates
          <span className="font-normal text-muted-foreground text-xs tabular-nums">{updates.length}</span>
          {plain.length > 0 && (
            <Button
              size="sm"
              className="ml-auto"
              disabled={apply.isPending}
              onClick={() => apply.mutate({ updates: plain.map((update) => ({ key: update.key })) })}
            >
              Update all{plain.length < updates.length ? ` (${plain.length} not Modified)` : ""}
            </Button>
          )}
        </h2>
        {apply.isError && <p className="text-destructive text-xs">{apply.error.message}</p>}
        {updates.length === 0 ? (
          <p data-testid="updates-empty" className="rounded-xl border px-5 py-6 text-muted-foreground text-sm">
            Every Imported Skill matches its Source.
          </p>
        ) : (
          <div className="divide-y overflow-hidden rounded-xl border">
            {updates.map((update) => (
              <UpdateRow key={update.key} update={update} />
            ))}
          </div>
        )}
      </section>
      {orphaned.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 font-semibold text-sm">
            Orphaned
            <span className="font-normal text-muted-foreground text-xs tabular-nums">{orphaned.length}</span>
          </h2>
          <div className="divide-y overflow-hidden rounded-xl border">
            {orphaned.map((skill) => (
              <OrphanedRow key={skill.key} skillKey={skill.key} reason={skill.reason} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
