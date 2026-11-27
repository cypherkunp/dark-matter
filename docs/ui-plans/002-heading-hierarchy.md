# Plan 002: Section headings are visibly a step above the rows they head

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `docs/ui-plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cabb160..HEAD -- packages/desktop/src/renderer/src`
> Plan 001 changes these files on purpose. Anything else that changed them is
> drift: compare against "Current state" and STOP on a mismatch.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: docs/ui-plans/001-type-scale.md (needs the `text-section`, `text-body`, `text-meta` tokens)
- **Category**: tech-debt (UI)
- **Planned at**: commit `cabb160`, 2026-11-27

## Why this matters

The Inbox, Library and Project pages are made of sections ("~/.claude/skills 4", "New Skills in ⭐ acme/tools", …), each heading a list of rows. Today the section heading is the same size as the row titles under it, so you can't scan a page by its sections. Uppercase micro-labels with wide letter spacing also clash with the app's newer sentence-case sidebar. After this plan, page title, group heading, section heading, row title and meta text form five distinct steps.

## Current state

After plan 001, the type tokens in `packages/desktop/src/renderer/src/styles.css` are: `text-display` 28px, `text-heading` 17px, `text-section` 14px, `text-lead` 14px, `text-body` 13px, `text-meta` 12px, `text-micro` 11px.

At `cabb160` (before plan 001), sub-section headings looked like this, `routes/inbox.tsx:98-110`:

```tsx
<section data-testid="inbox-group" className="flex flex-col gap-3">
  <h2 className="flex flex-wrap items-center gap-2 font-semibold text-sm">
    <span className="font-mono">{group.folder}</span>
    <span className="font-normal text-muted-foreground text-xs tabular-nums">{group.findings.length}</span>
    ...
  </h2>
  <div className="divide-y rounded-xl border">
```

and row titles like this, `components/skill-list.tsx:29`:

```tsx
<span className="font-medium text-sm">{skill.name}</span>;
```

Plan 001 maps both `text-sm` to `text-body`, so after 001 they are still equal (13px). There are about 30 such h2s: `grep -rnE "<h[23][^>]*font-semibold text-body" --include='*.tsx' packages/desktop/src/renderer/src` lists them.

Uppercase labels at `cabb160`:

- `components/command-palette.tsx:84`: `px-2.5 pt-2 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide` (group label)
- one h3 with `font-medium text-muted-foreground text-xs uppercase tracking-wide` (find it with `grep -rn "uppercase tracking-wide"`)

Page head, `components/page-head.tsx` (after plan 001):

```tsx
<div className="flex flex-col gap-1">
  <h1 className="text-balance font-bold text-display">{title}</h1>
  <p className="text-muted-foreground text-lead">{summary}</p>
  {status && <p className="text-muted-foreground text-meta">{status}</p>}
</div>;
```

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

- `*.tsx` files under `packages/desktop/src/renderer/src/` that contain an `<h2>`/`<h3>` with `font-semibold text-body`
- `components/page-head.tsx`
- `components/command-palette.tsx` (group label only)
- The file holding the `uppercase tracking-wide` h3

**Out of scope**:

- `components/skill-preview.tsx` (user Markdown).
- Row titles. Plan 005 owns rows.
- `text-heading` h2s (group headings and empty-state titles): they're already a clear step up.

## Git workflow

- Branch: `style/002-heading-hierarchy`
- Commit e.g.: `style(desktop): section headings sit a step above their rows`

## Steps

### Step 1: Promote sub-section headings

For every `<h2` or `<h3` whose className contains `font-semibold text-body`, replace `text-body` with `text-section`. Leave every other class alone. Inside those headings:

- Count spans (`font-normal text-muted-foreground text-meta tabular-nums`): leave as is.
- A `<span className="font-mono">` that holds a folder or source (e.g. `routes/inbox.tsx`, the `group.folder` and `group.source` spans) → `font-mono font-medium`. Semibold monospace reads heavy.

**Verify**: `grep -rnE "<h[23][^>]*font-semibold text-body" --include='*.tsx' packages/desktop/src/renderer/src` → no output.

### Step 2: Sentence-case labels

Remove `uppercase tracking-wide` from the command-palette group label and from the h3 found in Current state. Keep their size and colour.

**Verify**: `grep -rn "uppercase" --include='*.tsx' packages/desktop/src/renderer/src` → no output.

Before deleting `uppercase`, check e2e for exact-case text assertions on these labels: `grep -rn "toHaveText" packages/desktop/e2e | grep -iE "skills|namespaces|projects|actions|collections"`. CSS `uppercase` doesn't change DOM text, so they should be unaffected. If one asserts an upper-case string, STOP.

### Step 3: Page head rhythm

In `components/page-head.tsx`:

- Wrapper `gap-1` → `gap-1.5`.
- Status `<p>`: add `text-muted-foreground/80` in place of `text-muted-foreground`, so it reads one step quieter than the summary.

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Check

`pnpm format && pnpm lint`, `pnpm typecheck`, `pnpm build && pnpm test:e2e` → all pass. Visual check: on `/inbox`, the `~/.claude/skills` heading is visibly larger than the row titles `docx`, `pdf` below it; command-palette group labels (⌘K) are sentence case.

## Done criteria

- [ ] Step 1 and Step 2 greps print nothing
- [ ] `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test:e2e` 0 failed
- [ ] Only in-scope files changed (`git status`)
- [ ] `docs/ui-plans/README.md` status row updated

## STOP conditions

- Plan 001 hasn't landed (no `--text-section` in `styles.css`).
- An h2 with `font-semibold text-body` is inside a dialog and promoting it makes the dialog title (`text-heading`) and it look the same weight and size. Report the file and line instead of changing it.
- An e2e test fails because of a case change.

## Maintenance notes

- Heading ladder for new UI: page `h1` = `text-display font-bold`; group `h2` = `text-heading font-semibold`; section `h2`/`h3` = `text-section font-semibold`; row title = `text-body font-medium`; secondary = `text-meta text-muted-foreground`.
- No uppercase labels: the app's language is sentence case (see `docs/design/visual-reference.md`, "Refresh" section).
