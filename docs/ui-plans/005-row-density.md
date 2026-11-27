# Plan 005: List rows read as a title plus one quiet line

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `docs/ui-plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cabb160..HEAD -- packages/desktop/src/renderer/src`
> Plans 001 (sizes), 002 (headings) and 004 (chips) change these files on
> purpose. A changed row _structure_ (different lines, different data) at a
> listed location is drift: STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (many rows; e2e tests read their text)
- **Depends on**: docs/ui-plans/001-type-scale.md, docs/ui-plans/004-chip-component.md
- **Category**: tech-debt (UI)
- **Planned at**: commit `cabb160`, 2026-11-27

## Why this matters

Every list row in Dark Matter (Skills, Inbox findings, MCP Servers, Project Skills) stacks three lines: a title, a description, then a monospace line of keys and paths. Some add a fourth hint line. At 12–13px with nothing to separate them, a list of four Skills becomes a wall of grey text (the Inbox at `cabb160` shows ~140px per row). After this plan a row is a title with its chips, then **one** muted line where the description comes first and the identifier trails after a `·` in smaller monospace. Hints and errors keep their own line because they ask for action. All text stays in the DOM, so tests that read it still pass.

## Current state

The repeated row shape, `components/skill-list.tsx:17-55` at `cabb160` (sizes shown before plan 001; after 001, `text-sm` → `text-body`, `text-xs` → `text-meta`; after 004, the Local Source span is a `<Chip mono>`):

```tsx
<Link ... data-testid="library-skill" className="flex min-h-16 min-w-0 flex-1 items-center gap-3 py-3 pr-5 pl-2">
  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
    <div className="flex items-center gap-2">
      <span className="font-medium text-sm">{skill.name}</span>
      {skill.localSource && <span className="rounded-md border … font-mono text-[11px] …">Local Source</span>}
      {skill.modified && <ModifiedBadge />}
      ...
    </div>
    {skill.description && <p className="truncate text-muted-foreground text-xs">{skill.description}</p>}
    <div className="truncate font-mono text-muted-foreground text-xs">
      {[skill.key, skill.localSource].filter(Boolean).join(" · ")}
    </div>
  </div>
  <span data-testid="project-count" className="shrink-0 text-muted-foreground text-xs tabular-nums">…</span>
  <ChevronRight className="size-4 text-muted-foreground" />
</Link>
```

and `routes/inbox.tsx:55-88` (the `Finding` row):

```tsx
<div data-testid="inbox-finding" className="flex min-h-16 items-center gap-3 px-5 py-3">
  <TickBox … /> <StatusDot … />
  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
    <div className="flex items-center gap-2"><span className="font-medium text-sm">{finding.name}</span>…</div>
    {finding.description && <p className="truncate text-muted-foreground text-xs">{finding.description}</p>}
    <div className="truncate font-mono text-muted-foreground text-xs">
      {[finding.source, finding.realPath, ...reachedFrom.map((location) => `↖ ${location.path}`)].filter(Boolean).join(" · ")}
    </div>
    {finding.notAdoptableReason && <ReadOnlyReason reason={…} owner={…} />}
  </div>
  <div className="flex gap-1.5"> …Ignore / Adopt buttons… </div>
</div>
```

Rows with this shape (container `min-h-16 … py-3` plus a `truncate font-mono text-muted-foreground` detail line), at `cabb160`:

| File                              | Row (line)        | Test id                                                                                |
| --------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| `components/skill-list.tsx`       | 22                | `library-skill`                                                                        |
| `routes/inbox.tsx`                | 55, 123, 181, 235 | `inbox-finding`, `inbox-untracked-finding`, `inbox-new-skill`, `inbox-managed-finding` |
| `components/inbox-mcp.tsx`        | 83, 159           | `inbox-mcp-finding`, `inbox-untracked-mcp-finding`                                     |
| `components/inbox-drift.tsx`      | 42                | `inbox-drift-finding`                                                                  |
| `components/managed-mcp.tsx`      | 34                | `managed-mcp-server`                                                                   |
| `components/project-skills.tsx`   | 69                | `project-skill-row`                                                                    |
| `components/skill-projects.tsx`   | 16                | `skill-project-row`                                                                    |
| `routes/library_.trash.tsx`       | 41                | `trashed-skill`                                                                        |
| `routes/projects/suggested.tsx`   | 28                | `suggested-project`                                                                    |
| `routes/computer/mcp-servers.tsx` | 163               | `library-mcp-server`                                                                   |

E2E tests read row text with `toContainText`, e.g. `e2e/adopt.test.ts:34`: `expect(namespace.getByTestId("library-skill")).toContainText("Work with PDFs")`. `toContainText` reads the whole row's text, so moving text between lines in the same row is safe; **removing** text is not.

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

- `packages/desktop/src/renderer/src/components/row-text.tsx` (create)
- The files and rows in the table above

**Out of scope**:

- Rows inside dialogs (`adopt-dialog.tsx`, `mcp-adopt-dialog.tsx`, `add-to-projects.tsx`, the add-dialogs in `collection.tsx`, `project-skills.tsx:176`, `project-mcp-servers.tsx:397`).
- `routes/first-run.tsx`, `components/activity-view.tsx` (a log, not a list), `components/skill-files.tsx` (file tree), `routes/skill.tsx` (page header).
- `components/project-mcp-servers.tsx` rows: they hold form controls; leave them.
- List containers (borders, dividers). Plan 006 owns those.
- Any text content, `data-testid`, button or handler.

## Git workflow

- Branch: `style/005-row-density`
- Commit e.g.: `style(desktop): list rows are a title plus one quiet line`

## Steps

### Step 1: Create `RowText`

`packages/desktop/src/renderer/src/components/row-text.tsx`:

```tsx
import type { ReactNode } from "react";

/**
 * The text column of a list row: a title with its chips, then one muted line
 * (description first, identifier after a `·` in small monospace), then any
 * notes that ask for action (reasons, errors) on their own lines.
 */
export function RowText({
  title,
  chips,
  description,
  detail,
  children,
}: {
  title: ReactNode;
  chips?: ReactNode;
  description?: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-body">{title}</span>
        {chips}
      </div>
      {(description || detail) && (
        <p className="truncate text-meta text-muted-foreground">
          {description}
          {description && detail && <span aria-hidden> · </span>}
          {detail && <span className="font-mono text-micro text-muted-foreground/80">{detail}</span>}
        </p>
      )}
      {children}
    </div>
  );
}
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Convert the two exemplar rows

`components/skill-list.tsx`: replace the inner `<div className="flex min-w-0 flex-1 flex-col gap-0.5">…</div>` with

```tsx
<RowText
  title={skill.name}
  chips={<>{/* the existing Local Source / Modified / Orphaned / Name Conflict elements, unchanged */}</>}
  description={skill.description}
  detail={[skill.key, skill.localSource].filter(Boolean).join(" · ")}
/>;
```

On the `<Link>`: `min-h-16` → `min-h-14`, `py-3` → `py-2.5`.

`routes/inbox.tsx` `Finding` (line 55): same conversion. `detail` is the existing joined `[finding.source, finding.realPath, …reachedFrom]` expression; `{finding.notAdoptableReason && <ReadOnlyReason … />}` becomes `children` of `RowText`. On the row `<div>`: `min-h-16` → `min-h-14`, `py-3` → `py-2.5`.

**Verify**: `pnpm build && cd packages/desktop && npx playwright test e2e/adopt.test.ts e2e/scan.test.ts e2e/favourites.test.ts` → all pass.

### Step 3: Convert the remaining rows

Apply the same mapping to every other row in the table:

- title span → `title`; chips/badges next to it → `chips`
- description `<p>` → `description`
- the `truncate font-mono …` detail element's content → `detail`
- any further lines (hints, reasons, `ConsentError`, "guarded" text with its `data-testid`) → `children`, unchanged and in the same order
- row container `min-h-16` → `min-h-14`, `py-3` → `py-2.5`

If a row has a detail line but no description, pass only `detail`: it renders alone on the second line.

**Verify** after each file: `pnpm typecheck` → exit 0.

### Step 4: Check

1. `cd packages/desktop/src/renderer/src && grep -rn "min-h-16" components/skill-list.tsx routes/inbox.tsx components/inbox-mcp.tsx components/inbox-drift.tsx components/managed-mcp.tsx components/project-skills.tsx components/skill-projects.tsx routes/library_.trash.tsx routes/projects/suggested.tsx routes/computer/mcp-servers.tsx` → only the `data-testid="inbox-suggested-projects"` card link in `routes/inbox.tsx` (a standalone card, not a list row; leave it).
2. `pnpm format && pnpm lint`, `pnpm typecheck` → exit 0.
3. `pnpm build && pnpm test:e2e` → 0 failed.
4. Visual check: on `/inbox` each finding is two lines plus the lock hint (when present), about 30% shorter than before. Long paths truncate with an ellipsis instead of wrapping.

## Done criteria

- [ ] `components/row-text.tsx` exports `RowText`
- [ ] `grep -rln "<RowText" packages/desktop/src/renderer/src | wc -l` → 10 (one per file in the table)
- [ ] Step 4 grep prints nothing
- [ ] `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test:e2e` 0 failed
- [ ] `docs/ui-plans/README.md` status row updated

## STOP conditions

- A row's detail element carries its own `data-testid` or is asserted on by itself in e2e (`grep -rn "getByTestId" packages/desktop/e2e` then check). Report it; don't fold it into `detail` unless the test id can stay on a wrapping `<span>`.
- A row has two separate monospace lines (not one joined line). Report it rather than choosing one.
- An e2e test fails because text it reads moved out of its row element.

## Maintenance notes

- New list rows should use `RowText`. Keep at most one muted line; anything that asks the user to act goes in `children`.
- Plan 006 removes the boxes around these lists. It assumes rows already have `py-2.5`.
