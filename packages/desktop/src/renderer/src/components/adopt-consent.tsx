import { type AgentId, type NotAdoptableReason, readOnlyReasonText } from "@dark-matter/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { useState } from "react";
import { useTRPC } from "@/lib/trpc";

/**
 * What the user ticked to Adopt (ADR-0007): starts empty, and only ids that
 * can be adopted right now count, so a tick that loses its Adopt Permission
 * drops out of the plan.
 */
export function useTicked(adoptable: readonly string[]) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const allowed = new Set(adoptable);
  return {
    ids: adoptable.filter((id) => ticked.has(id)),
    has: (id: string) => allowed.has(id) && ticked.has(id),
    toggle: (id: string, on: boolean) =>
      setTicked((current) => {
        const next = new Set(current);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    clear: () => setTicked(new Set()),
  };
}

/** The label of the button that Adopts what's ticked. */
export const adoptTickedLabel = (count: number) => (count > 0 ? `Adopt ${count} ticked` : "Adopt ticked");

/** The tick box of one finding; disabled, with a lock, when it can't be adopted. */
export function TickBox({
  name,
  adoptable,
  checked,
  onChange,
}: {
  name: string;
  adoptable: boolean;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label={name}
      className="size-4 shrink-0 accent-primary disabled:opacity-40"
      disabled={!adoptable}
      checked={adoptable && checked}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

/** Why a finding is read-only, in words, with a lock. */
export function ReadOnlyReason({ reason, owner }: { reason: NotAdoptableReason; owner: AgentId }) {
  return (
    <p data-testid="read-only-reason" className="flex items-center gap-1 text-muted-foreground text-meta">
      <Lock className="size-3 shrink-0" />
      {readOnlyReasonText(reason, owner)}
    </p>
  );
}

/** Whether the Agent Config Guard is on (ADR-0007); true until settings load, the safe default. */
export function useAgentConfigGuard() {
  const trpc = useTRPC();
  return useQuery(trpc.settings.get.queryOptions()).data?.preferences.agentConfigGuard ?? true;
}

export const guardedOffSwitchText =
  "The Agent Config Guard is on, so Dark Matter won't edit this Agent's settings. Turn it off in Settings › Agents.";

/** Tags of errors the core raises when ADR-0007's gating refuses something. */
const consentTags = new Set(["NotAdoptable", "AgentConfigGuarded"]);

/**
 * An Adopt or off switch error. When the core refused it because of an Adopt
 * Permission or the Agent Config Guard (the settings changed meanwhile), it
 * says so and points to Settings › Agents.
 */
export function ConsentError({
  error,
  className,
}: {
  error: { message: string; data?: unknown } | null;
  className?: string;
}) {
  if (!error) return null;
  const tag = (error.data as { tag?: string } | undefined)?.tag;
  return (
    <p data-testid="consent-error" className={className ?? "text-body text-status-warning"}>
      {error.message}
      {tag && consentTags.has(tag) && (
        <>
          {" "}
          <Link to="/settings" className="underline">
            Open Settings
          </Link>
        </>
      )}
    </p>
  );
}
