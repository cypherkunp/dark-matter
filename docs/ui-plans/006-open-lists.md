# Plan 006: Page lists are open rows on the panel, not bordered boxes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `docs/ui-plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cabb160..HEAD -- packages/desktop/src/renderer/src`
> Plans 001–005 change these files on purpose. A list container at a listed
> location that no longer reads `divide-y … rounded-xl border` is drift: STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (classes only; visible on every screen)
- **Depends on**: docs/ui-plans/005-row-density.md (rows must already be `py-2.5`)
- **Category**: direction (UI)
- **Planned at**: commit `cabb160`, 2026-11-27

## Why this matters

The app now draws a dark window frame around one rounded content panel. Inside that panel, every list is another rounded, bordered box with dividers between rows, so a page reads as boxes inside a box inside a box. The visual reference this design follows lays rows directly on the panel: no outline, no dividers, a soft rounded highlight on hover. The owner chose this direction on 2026-11-27. After this plan, page lists are open; form groups, alerts, dialogs and scroll panes keep their boxes because there the box carries meaning.

## Current state

- Page lists at `cabb160` are a container `divide-y rounded-xl border` (sometimes with `overflow-hidden`) whose children are rows with horizontal padding `px-5` (or `pr-5 pl-2` plus a leading star button in `skill-list.tsx`).
- After plan 005, rows are `min-h-14 … py-2.5`.
- Example, `routes/inbox.tsx:98-115`:

  ```tsx
  <section data-testid="inbox-group" className="flex flex-col gap-3">
    <h2 …>…</h2>
    <div className="divide-y rounded-xl border">
      {group.findings.map((finding) => <Finding key={finding.id} … />)}
    </div>
  </section>
  ```
- Empty states, e.g. `routes/library.tsx:28-31`:

  ```tsx
  <section data-testid="library-empty" className="flex flex-col items-center gap-3 rounded-xl border px-6 py-16 text-center">
  ```
- Hover today: rows that are links use `hover:bg-muted/50` (e.g. `skill-list.tsx:19`).

### Lists to open (page-level, at `cabb160`)

`routes/inbox.tsx:110,179,213,284` · `components/skill-list.tsx:63` · `routes/library_.collections.tsx:67` · `routes/library_.favourites.tsx:45` · `routes/library_.trash.tsx:39` · `routes/project.tsx:79,131` · `routes/projects/suggested.tsx:109` · `routes/computer/mcp-servers.tsx:233` · `routes/collection.tsx:103,146` · `components/inbox-mcp.tsx:134,210` · `components/managed-mcp.tsx:97` · `components/inbox-requests.tsx:70` · `components/inbox-drift.tsx:91` · `components/updates.tsx:206,219` · `components/inventory.tsx:62` · `components/skill-projects.tsx:56` · `components/project-skills.tsx:248` · `components/repo-skills.tsx:42,79` · `components/ignored-findings.tsx:102` · `components/github-import.tsx:117`

### Boxes to keep

- Dialog contents and scroll panes: anything with `overflow-y-auto`, and lists in `adopt-dialog.tsx`, `mcp-adopt-dialog.tsx`, `add-to-projects.tsx`, `collection.tsx:258,318`, `project-skills.tsx:176`, `project-mcp-servers.tsx:397`, `skills-sh.tsx:153`.
- Settings form groups: `routes/settings.tsx:93`, `components/agents-settings.tsx:72`, `components/project-mcp-servers.tsx:542`.
- Warning and alert panels (`border-warning-border`), the overview stat strip, `routes/first-run.tsx` (its own flow).

## Commands you will need

Run from the repo root.

| Purpose      | Command                               | Expected on success |
| ------------ | ------------------------------------- | ------------------- |
| Format, Lint | `pnpm format && pnpm lint`            | exit 0              |
| Typecheck    | `pnpm typecheck`                      | exit 0              |
| Build + E2E  | `pnpm build && pnpm test:e2e`         | 0 failed            |
| Visual check | see `docs/ui-plans/tools/capture.test.ts.txt` | PNGs in `$SHOT_DIR` |

## Scope

**In scope**: the files in "Lists to open", plus the empty-state sections found in Step 3.

**Out of scope**: everything in "Boxes to keep"; row content (plan 005); any `data-testid`, text or handler.

## Git workflow

- Branch: `style/006-open-lists`
- Commit e.g.: `style(desktop): page lists sit open on the panel`

## Steps

### Step 1: Add one shared class pair

Create `packages/desktop/src/renderer/src/components/list.ts`:

```ts
/** A page list: rows sit open on the content panel, outdented so their text lines up with the heading above. */
export const openList = "-mx-3 flex flex-col gap-px";
/** A row in an open list: a soft rounded highlight on hover instead of a divider. */
export const openRow = "rounded-xl px-3 transition-colors hover:bg-foreground/[0.04]";
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Open each listed list

For each location in "Lists to open":

1. Replace the container's `divide-y`, `rounded-xl`, `border` and `overflow-hidden` classes with `openList` (`className={openList}`, or `cn(openList, "<kept classes>")` if it had others, e.g. `flex flex-col`).
2. On each **direct child row** of that container (in the same file or in the row component it renders, e.g. `Finding` in `routes/inbox.tsx`, `SkillRow` in `components/skill-list.tsx`): replace `px-5` with the `openRow` classes. For `SkillRow`, whose outer `<div>` has `hover:bg-muted/50` and whose `<Link>` has `pr-5 pl-2`: put `openRow` on the outer `<div>` (drop `hover:bg-muted/50`) and change the Link's `pr-5` to `pr-0`.
3. Remove any row-level `hover:bg-muted/50`; `openRow` provides the hover.

Import with `import { openList, openRow } from "@/components/list";` and `cn` from `@/lib/utils` if you combine classes.

**Verify** (after all files): `cd packages/desktop/src/renderer/src && grep -rn "divide-y" --include='*.tsx' . | grep -v "overflow-y-auto"` → only lines in the "Boxes to keep" files.

### Step 3: Soften empty states

Find them: `grep -rn "items-center gap-3 rounded-xl border px-6 py-16 text-center" --include='*.tsx' packages/desktop/src/renderer/src`. In each, replace `rounded-xl border` with `rounded-2xl bg-foreground/[0.025]`.

**Verify**: the same grep → no output.

### Step 4: Check

`pnpm format && pnpm lint`, `pnpm typecheck`, `pnpm build && pnpm test:e2e` → all pass.
Visual check (light and dark): on `/inbox` and `/library` (with Skills Adopted), rows sit directly on the panel, their text left edge lines up with the section heading, and hovering a row shows a soft rounded fill. Settings still shows bordered groups.

## Done criteria

- [ ] `components/list.ts` exports `openList` and `openRow`
- [ ] Step 2 and Step 3 greps as stated
- [ ] `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test:e2e` 0 failed
- [ ] `docs/ui-plans/README.md` status row updated

## STOP conditions

- A list's rows are rendered by a component shared with a dialog list (changing the row would also change the dialog). Report the component name.
- The negative margin (`-mx-3`) makes a row overflow the page frame horizontally (a horizontal scrollbar appears in the panel).
- An e2e test clicks a row by position and fails after the change.

## Maintenance notes

- Use `openList`/`openRow` for new page lists. Use a bordered box only for form groups, warnings, dialogs and scroll panes.
- If a page ever needs a dense table look again, prefer a header row and zebra-free open rows over reintroducing borders.
