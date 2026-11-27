import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const tones = {
  neutral: "bg-foreground/[0.06] text-muted-foreground",
  warning: "bg-warning-surface text-warning-foreground",
  on: "bg-status-on/12 text-status-on",
  accent: "bg-primary/10 text-primary",
} as const;

export type ChipTone = keyof typeof tones;

/** The classes of a Chip, for elements that must stay a link or button. */
export const chipClass = ({
  tone = "neutral",
  mono = false,
}: {
  tone?: ChipTone | undefined;
  mono?: boolean | undefined;
} = {}) =>
  cn(
    "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 font-medium text-micro whitespace-nowrap",
    mono && "font-mono font-normal",
    tones[tone],
  );

/** A small pill label: monospace for identifiers (Namespaces, Agent folders, keys), sans for states. */
export function Chip({
  tone,
  mono,
  className,
  ...props
}: ComponentProps<"span"> & { tone?: ChipTone; mono?: boolean }) {
  return <span className={cn(chipClass({ tone, mono }), className)} {...props} />;
}
