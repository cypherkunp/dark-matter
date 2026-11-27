import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The frame every main-window screen sits in: centred, at most 64rem wide, padded inside the content panel. */
export function Page({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto flex w-full max-w-5xl flex-col gap-8 px-10 py-9", className)}>{children}</div>;
}
