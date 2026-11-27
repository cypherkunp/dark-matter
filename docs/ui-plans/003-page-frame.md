# Plan 003: Every main-window screen sits in one shared `<Page>` frame

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `docs/ui-plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cabb160..HEAD -- packages/desktop/src/renderer/src/routes packages/desktop/src/renderer/src/components/page.tsx`
> Plans 001/002 may have changed class names in these files (sizes only). Any
> change to the outer `<div className="mx-auto ...">` lines is drift: STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (can run before or after 001/002)
- **Category**: tech-debt (UI)
- **Planned at**: commit `cabb160`, 2026-11-27

## Why this matters

Twenty route files copy the same page frame by hand (`mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9`), with small variations. Two screens, **GitHub import** and **skills.sh**, don't use it at all: they have no padding, so their title and fields press against the top-left corner of the rounded content panel and don't line up with any other screen. One shared component fixes both screens and makes future spacing changes a one-line edit.

## Current state

- `packages/desktop/src/renderer/src/routes/__root.tsx` renders every screen inside the rounded content panel (`data-testid="content-panel"`, `overflow-y-auto`).
- The standard frame, e.g. `routes/library.tsx:20`:

  ```tsx
  <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
  ```

  Found in (at `cabb160`): `routes/library.tsx:20`, `library_.collections.tsx:30`, `library_.favourites.tsx:18`, `library_.trash.tsx:21`, `library_.updates.tsx:29`, `namespace.tsx:30`, `settings.tsx:78`, `inbox.tsx:316`, `project.tsx:180`, `project.tsx:189`, `collection.tsx:70`, `projects/suggested.tsx:82`, `computer/agents.tsx:84`, `computer/mcp-servers.tsx:212`, `$.tsx:12`.
- Variants:
  - `routes/skill.tsx:87`: `mx-auto flex max-w-5xl flex-col gap-6 px-10 py-9`
  - `routes/collection.tsx:61`: `mx-auto flex max-w-5xl flex-col gap-4 px-10 py-9` (Collection not found)
  - `routes/computer/activity.tsx:173`: `mx-auto flex h-full max-w-5xl flex-col gap-6 px-10 py-9`
- **The broken ones**, `routes/get/github.tsx:17` and `routes/get/skills-sh.tsx:26`:

  ```tsx
  <div className="flex max-w-3xl flex-col gap-6">
  ```
- `routes/first-run.tsx:56` (`mx-auto flex h-full max-w-3xl flex-col gap-6 px-10 py-12`) is the First run. It renders **outside** the panel, full-window, and keeps its own frame.
- Class merging: import `cn` from `@/lib/utils`. It merges Tailwind conflicts, so `cn("gap-8", "gap-6")` → `"gap-6"` (verified).
- Component style to match: small named function components with a one-line JSDoc, e.g. `components/page-head.tsx`, `components/status-dot.tsx`.

## Commands you will need

Run from the repo root.

| Purpose      | Command                                                            | Expected on success |
| ------------ | ------------------------------------------------------------------ | ------------------- |
| Format, Lint | `pnpm format && pnpm lint`                                         | exit 0              |
| Typecheck    | `pnpm typecheck`                                                   | exit 0              |
| Build + E2E  | `pnpm build && pnpm test:e2e`                                      | 0 failed            |
| Visual check | see `docs/ui-plans/tools/capture.test.ts.txt` (captures `/get/github` too) | PNGs in `$SHOT_DIR` |

## Scope

**In scope**:

- `packages/desktop/src/renderer/src/components/page.tsx` (create)
- The route files listed in Current state (not `first-run.tsx`)

**Out of scope**:

- `routes/first-run.tsx` — different shell, deliberately narrower.
- The inner `max-w-3xl` wrappers in `components/skill-preview.tsx` and `components/skill-provenance.tsx`: they bound readable content inside a page.
- Any change inside the frame (headings, lists).

## Git workflow

- Branch: `refactor/003-page-frame`
- Commit e.g.: `refactor(desktop): one Page frame for every screen; pad the Get Skills screens`

## Steps

### Step 1: Create the component

`packages/desktop/src/renderer/src/components/page.tsx`:

```tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The frame every main-window screen sits in: centred, at most 64rem wide, padded inside the content panel. */
export function Page({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto flex w-full max-w-5xl flex-col gap-8 px-10 py-9", className)}>{children}</div>;
}
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Use it in the standard routes

In each standard file listed in Current state, replace the opening
`<div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">` with `<Page>` and its matching closing `</div>` with `</Page>`. Add `import { Page } from "@/components/page";`. Be careful to pick the matching closing tag: it's the last `</div>` of that return block.

For the variants:

- `skill.tsx:87` → `<Page className="gap-6">`
- `collection.tsx:61` → `<Page className="gap-4">`
- `computer/activity.tsx:173` → `<Page className="h-full gap-6">`

**Verify**: `grep -rn "mx-auto flex" --include='*.tsx' packages/desktop/src/renderer/src/routes` → only `first-run.tsx`.

### Step 3: Fix the Get Skills screens

In `routes/get/github.tsx` and `routes/get/skills-sh.tsx`, replace
`<div className="flex max-w-3xl flex-col gap-6">` … `</div>` with `<Page className="gap-6">` … `</Page>`.

**Verify**: `grep -rn "max-w-3xl" packages/desktop/src/renderer/src/routes/get` → no output.

### Step 4: Check

`pnpm format && pnpm lint`, `pnpm typecheck`, `pnpm build && pnpm test:e2e` → all pass.
Visual check: `light_get_github.png` shows the "GitHub import" title with the same top and left padding as `light_library.png`. No other screen moved (compare against a `cabb160` capture).

## Done criteria

- [ ] `components/page.tsx` exists and exports `Page`
- [ ] `grep -rln "<Page" packages/desktop/src/renderer/src/routes | wc -l` → 18
- [ ] Step 2 and Step 3 greps as stated
- [ ] `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test:e2e` 0 failed
- [ ] `docs/ui-plans/README.md` status row updated

## STOP conditions

- A listed line isn't the outermost element of its route's returned JSX (e.g. it's wrapped in a fragment with siblings that depend on its padding).
- After Step 3, a GitHub import or skills.sh input or results list stretches past ~64rem and looks broken. Report it with a screenshot instead of adding wrappers.

## Maintenance notes

- New screens must start with `<Page>`. Change page padding or width only in `components/page.tsx`.
- The count in Done criteria (18 files) is as of `cabb160`; a route added since then makes it higher, which is fine.
