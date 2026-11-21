import { cn } from "@/lib/utils";

const tones = {
  on: "bg-status-on",
  healthy: "bg-status-healthy",
  off: "bg-status-off",
  warning: "bg-status-warning",
} as const;

export type StatusTone = keyof typeof tones;

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", tones[tone], className)} />;
}
