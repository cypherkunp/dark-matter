# Plan 004: All small labels and status pills come from one `Chip` with readable tones

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `docs/ui-plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cabb160..HEAD -- packages/desktop/src/renderer/src`
> Plan 001 renames `text-[11px]` to `text-micro` in these files. That's
> expected. Any other change at a listed line is drift: STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: docs/ui-plans/001-type-scale.md (uses `text-micro` and the `cn` that knows it)
- **Category**: tech-debt (UI)
- **Planned at**: commit `cabb160`, 2026-11-27

## Why this matters

About 40 places hand-build a small label or status pill ("Local Source", "Modified", "Name Conflict", Agent names, Namespace keys, "failed", "detected"). They mix square (`rounded-md`) and pill (`rounded-full`) corners, outlined and filled styles, and three paddings. The app's design language is pill chips with a soft tinted fill and no outline (`docs/design/visual-reference.md`, "Refresh": "Buttons and the sidebar filter are pills… soft tinted chips"). The warning chips are also hard to read in light mode: amber text `--status-warning` (oklch 0.68) on the pale amber `--warning-surface` (oklch 0.97) is roughly 2.5:1 contrast, below the 4.5:1 floor. One component fixes the look, the contrast and the duplication.

## Current state

- `packages/desktop/src/renderer/src/styles.css`: light-mode `:root` has `--status-warning: oklch(0.68 0.15 65)` and `--warning-surface: oklch(0.97 0.025 80)`; `.dark` has `--status-warning: oklch(0.79 0.14 75)` and `--warning-surface: oklch(0.79 0.14 75 / 11%)`. Theme colours are exposed to Tailwind in the `@theme inline` block as `--color-NAME: var(--NAME);` (e.g. `--color-warning-surface: var(--warning-surface);`).
- Typical call sites at `cabb160` (after plan 001, `text-[11px]` reads `text-micro`):
  - `components/skill-list.tsx:31` — `rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground` ("Local Source")
  - `components/skill-list.tsx:40` — `rounded-md border border-warning-border bg-warning-surface px-1.5 py-0.5 text-[11px]` ("Name Conflict", `data-testid="name-conflict"`)
  - `components/modified-badge.tsx:7` — `rounded-full bg-warning-surface px-2 py-0.5 font-medium text-[11px] text-status-warning`
  - `components/copy-actions.tsx:8` — `const warningPill = "rounded-md border border-warning-border bg-warning-surface px-1.5 py-0.5 text-[11px]";`
  - Shared constants named `pill` in `components/repo-skills.tsx:5`, `project-mcp-servers.tsx:19`, `skill-projects.tsx:9`, `project-skills.tsx:18`
  - Full list: run the grep in Step 3.
- `cn` from `@/lib/utils` merges Tailwind classes (after plan 001 it knows `text-micro` is a size).
- Exemplar of a tiny presentational component: `components/status-dot.tsx`:

  ```tsx
  const tones = { on: "bg-status-on", healthy: "bg-status-healthy", off: "bg-status-off", warning: "bg-status-warning" } as const;
  export type StatusTone = keyof typeof tones;
  export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
    return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", tones[tone], className)} />;
  }
  ```
- Design rule to keep: **monospace chips for identifiers** (Namespaces, Agent folders, keys); sans chips for states.

## Commands you will need

Run from the repo root.

| Purpose      | Command                               | Expected on success |
| ------------ | ------------------------------------- | ------------------- |
| Format, Lint | `pnpm format && pnpm lint`            | exit 0              |
| Typecheck    | `pnpm typecheck`                      | exit 0              |
| Build + E2E  | `pnpm build && pnpm test:e2e`         | 0 failed            |
| Visual check | see `docs/ui-plans/tools/capture.test.ts.txt` | PNGs in `$SHOT_DIR` |

## Scope

**In scope**:

- `packages/desktop/src/renderer/src/styles.css` (one new colour token)
- `packages/desktop/src/renderer/src/components/ui/chip.tsx` (create)
- Every file returned by the Step 3 grep

**Out of scope**:

- Sidebar count badges in `components/sidebar.tsx` (`bg-primary … text-primary-foreground`): they're counters, not chips.
- `components/status-dot.tsx`.
- `<code>` and `<pre>` blocks that aren't chips (e.g. `adopt-dialog.tsx:60`, `copy-actions.tsx:78`: `rounded-lg bg-muted p-3 font-mono`).
- Any `data-testid` and any visible text: keep both exactly.

## Git workflow

- Branch: `refactor/004-chip`
- Commit e.g.: `refactor(desktop): one Chip for labels and status pills; readable warning text`

## Steps

### Step 1: Add a readable warning text colour

In `styles.css`:

- In `:root` add `--warning-foreground: oklch(0.48 0.12 60);`
- In `.dark` add `--warning-foreground: oklch(0.82 0.13 75);`
- In `@theme inline`, next to `--color-warning-border`, add `--color-warning-foreground: var(--warning-foreground);`

**Verify**: `pnpm build` → exit 0 and `grep -c "warning-foreground" packages/desktop/out/renderer/assets/*.css` ≥ 1 once a class uses it (after Step 2; at this step just the build).

### Step 2: Create the Chip

`packages/desktop/src/renderer/src/components/ui/chip.tsx`:

```tsx
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
export const chipClass = ({ tone = "neutral", mono = false }: { tone?: ChipTone; mono?: boolean } = {}) =>
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
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Replace the call sites

List them:

```sh
cd packages/desktop/src/renderer/src
grep -rnE "rounded-(md|full) (border|bg-)[^\"]*px-(1|1\.5|2) [^\"]*text-(\[11px\]|micro)|warningPill|rounded-full border px-2 py-px" --include='*.tsx' . | grep -v sidebar.tsx
```

Map each one with these rules:

| Old classes contain                                                                   | New                                                                               |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `border … font-mono … text-muted-foreground`                                          | `<Chip mono>`                                                                     |
| `border … text-muted-foreground` (no mono), or `bg-muted … text-muted-foreground`     | `<Chip>`                                                                          |
| `bg-warning-surface` (with or without `border-warning-border`, `text-status-warning`) | `<Chip tone="warning">`                                                           |
| `font-mono text-foreground` on a `<code>` (`routes/project.tsx:109`)                  | keep `<code>`, set `className={chipClass({ mono: true })}` plus `text-foreground` |

Keep every other attribute (`data-testid`, `title`, `key`, `aria-*`) and any layout class like `ml-auto` (pass it in `className`). For elements that are links or buttons (`routes/skill.tsx:48`, `components/skills-sh.tsx:113`), keep the element and set `className={cn(chipClass({ … }), "<their hover class>")}`.

Where a file defines `const pill = "…"` or `const warningPill = "…"`, delete the constant and use `<Chip …>` or `chipClass(…)` at its uses. `components/modified-badge.tsx` and the `OrphanedBadge` in `components/updates.tsx:17` become `<Chip tone="warning" …>` with their `data-testid` and `title` kept. For `adopt-dialog.tsx:50-51` and `mcp-adopt-dialog.tsx:38-39` (a ternary between warning and muted strings), use `<Chip tone={cond ? "warning" : "neutral"}>`.

**Verify**: re-run the grep above → no output. Then `pnpm typecheck` → exit 0.

### Step 4: Check

`pnpm format && pnpm lint`, `pnpm typecheck`, `pnpm build && pnpm test:e2e` → all pass.
Visual check: on `/inbox`, the Agent name chips (Claude Code, Cursor, OpenCode) are grey pills with no outline. Warning chips read as dark amber on pale amber in light mode and as light amber in dark mode.

## Done criteria

- [ ] `components/ui/chip.tsx` exports `Chip`, `chipClass`, `ChipTone`
- [ ] The Step 3 grep prints nothing
- [ ] `grep -rnE "const (pill|warningPill) =" packages/desktop/src/renderer/src` → no output
- [ ] Every `data-testid` from the old chips still exists: `grep -rn 'data-testid="\(name-conflict\|modified-badge\|copy-state\)"' packages/desktop/src/renderer/src` → 4 or more matches
- [ ] `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test:e2e` 0 failed
- [ ] `docs/ui-plans/README.md` status row updated

## STOP conditions

- An old chip uses a tone not in the table (e.g. green, red). Report it rather than inventing a tone.
- An e2e test asserts a class name or a style on a chip (`grep -rn "toHaveClass\|toHaveCSS" packages/desktop/e2e`).
- A chip sits in a line where `h-5` breaks alignment visibly (e.g. inside a tall heading). Report with a screenshot.

## Maintenance notes

- New small labels must use `Chip`. Add a tone to `tones` only with a contrast check (text vs. fill ≥ 4.5:1 in both themes).
- `--warning-foreground` is for warning **text** on tinted fills. `--status-warning` stays for dots and icons.
