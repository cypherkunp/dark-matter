import { ChevronDown } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A native <select> (the OS menu and keyboard handling stay) dressed like `Input`:
 * same height, radius, border and focus ring, with our own chevron instead of the
 * platform's. `className` sizes the control; the wrapper carries it.
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <span data-slot="select" className={cn("relative inline-flex h-8 w-fit shrink-0", className)}>
      <select
        className="peer h-full w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-body text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-2.5 size-3.5 text-muted-foreground peer-disabled:opacity-50"
      />
    </span>
  );
}

export { Select };
