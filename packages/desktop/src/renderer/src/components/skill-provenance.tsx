import type { SkillDetail } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { FilteredActivity } from "@/components/activity-view";
import { ConfirmDialog } from "@/components/copy-actions";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";

const field = (label: string, value: string | undefined) => (value ? [[label, value] as const] : []);

/** The Provenance tab: the Library Lock entry, where the Skill was Adopted from, Undo Adopt and its Activity. */
export function SkillProvenance({ skill }: { skill: SkillDetail }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const undo = useMutation(
    trpc.adopt.undo.mutationOptions({
      onSuccess: () => navigate({ to: "/library" }),
    }),
  );
  const [asking, setAsking] = useState(false);
  const undoPlan = useQuery({
    ...trpc.adopt.undoPlan.queryOptions({ key: skill.key }),
    enabled: asking,
    staleTime: 0,
    gcTime: 0,
  });
  const used = undoPlan.data?.projects ?? [];
  const links = used.filter((use) => use.mode === "link");
  const copies = used.filter((use) => use.mode !== "link");
  const { entry } = skill;
  const rows = [
    ...field("source", entry.source),
    ...field("sourceType", entry.sourceType),
    ...field("ref", entry.ref),
    ...field("commit", entry.commit),
    ...field("skillPath", entry.skillPath),
    ...field("computedHash", entry.computedHash),
    ...field("localSource", entry.localSource),
  ];

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold text-sm">
          Library Lock entry <span className="font-mono font-normal text-muted-foreground">"{skill.key}"</span>
        </h2>
        <dl
          data-testid="lock-entry"
          className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1.5 rounded-xl border px-4 py-3"
        >
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="font-mono text-muted-foreground text-xs">{label}</dt>
              <dd className="break-all font-mono text-xs">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold text-sm">Adopted from</h2>
        {entry.adoptedFrom ? (
          <div className="flex items-center gap-3 rounded-xl border px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1 font-mono text-xs">
              <span data-testid="adopted-from">{entry.adoptedFrom}</span>
              {(entry.adoptedLinks ?? []).map((link) => (
                <span key={link.path} className="text-muted-foreground">
                  symlink {link.path} → {link.target}
                </span>
              ))}
              {(entry.adoptedCopies ?? []).map((copy) => (
                <span key={copy} className="text-muted-foreground">
                  identical copy {copy}
                </span>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              title={`Move it back to ${entry.adoptedFrom}`}
              disabled={undo.isPending}
              onClick={() => setAsking(true)}
            >
              {undo.isPending ? "Undoing…" : "Undo Adopt"}
            </Button>
            {asking && (
              <ConfirmDialog
                title={`Undo Adopt of ${skill.name}?`}
                confirm="Undo Adopt"
                busy={undo.isPending || !undoPlan.data}
                error={(undoPlan.error ?? undo.error)?.message}
                onConfirm={() => undo.mutate({ key: skill.key })}
                onClose={() => setAsking(false)}
              >
                <p>
                  It moves back to <code className="font-mono text-xs">{entry.adoptedFrom}</code> and leaves the
                  Library.
                </p>
                {links.length > 0 && (
                  <p>Its Links are removed from {links.map((use) => use.projectName).join(", ")}.</p>
                )}
                {copies.length > 0 && (
                  <p>
                    Copies stay committed in {copies.map((use) => use.projectName).join(", ")} (Vendored from then on).
                  </p>
                )}
              </ConfirmDialog>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Not Adopted: it came into the Library another way.</p>
        )}
        {undo.error && <p className="text-status-warning text-xs">{undo.error.message}</p>}
      </section>

      <FilteredActivity search={{ skill: skill.key }} exportName={`activity-${skill.name}`} />
    </div>
  );
}
