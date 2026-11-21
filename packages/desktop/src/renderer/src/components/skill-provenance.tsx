import type { SkillDetail } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { actionLabel, clientLabel } from "@/lib/activity";
import { useTRPC } from "@/lib/trpc";

const field = (label: string, value: string | undefined) => (value ? [[label, value] as const] : []);

/** The Provenance tab: the Library Lock entry, where the Skill was Adopted from, Undo Adopt and its Activity. */
export function SkillProvenance({ skill }: { skill: SkillDetail }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const activity = useQuery(trpc.activity.list.queryOptions({}));
  const undo = useMutation(
    trpc.adopt.undo.mutationOptions({
      onSuccess: () => navigate({ to: "/library" }),
    }),
  );
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
  const history = (activity.data?.entries ?? []).filter((item) =>
    item.subjects.some((subject) => subject.kind === "skill" && subject.id === skill.key),
  );

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
              onClick={() => undo.mutate({ key: skill.key })}
            >
              {undo.isPending ? "Undoing…" : "Undo Adopt"}
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Not Adopted: it came into the Library another way.</p>
        )}
        {undo.error && <p className="text-status-warning text-xs">{undo.error.message}</p>}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold text-sm">Activity</h2>
        {history.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y rounded-xl border text-sm">
            {history.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2">
                <span className={item.result === "error" ? "text-status-warning" : ""}>{actionLabel(item.action)}</span>
                <span className="text-muted-foreground text-xs">by {clientLabel(item.client)}</span>
                <span className="ml-auto text-muted-foreground text-xs tabular-nums">
                  {new Date(item.time).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
