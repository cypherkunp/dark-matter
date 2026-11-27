# Plan 001: The desktop renderer uses one named type scale instead of 13 ad-hoc font sizes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `docs/ui-plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cabb160..HEAD -- packages/desktop/src/renderer/src`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt (UI)
- **Planned at**: commit `cabb160`, 2026-11-27

## Why this matters

The Dark Matter desktop app sets its base text to 13px, but components use Tailwind's `text-sm` (14px), `text-xs` (12px) and hand-picked `text-[11px]`, `[12px]`, `[13px]`, `[14px]`, `[26px]`, `[28px]`, `[0.8rem]`. Text that should look the same sits one pixel apart, so the UI looks accidental. After this plan, every size in the renderer comes from eight named tokens with fixed line heights, and later plans (002, 004, 005) can tune hierarchy by changing a token, not 400 class strings.

## Current state

- `packages/desktop/src/renderer/src/styles.css` — Tailwind v4.3 theme. The `@theme inline { ... }` block defines fonts, colours and radii but **no font sizes**. The body is set to 13px in `@layer base`:

  ```css
  body {
    @apply overflow-hidden bg-chrome text-foreground text-[13px] select-none;
  }
  ```
- Size usage across `packages/desktop/src/renderer/src/**/*.tsx` at `cabb160` (count from `grep -rhoE`):

  ```
  197 text-sm      180 text-xs      56 text-[11px]    18 text-base    14 text-lg
    8 text-[13px]    7 text-[12px]   2 text-2xl        1 text-xl        1 text-[28px]
    1 text-[26px]    1 text-[14px]   1 text-[0.8rem]
  ```
- Examples:
  - `components/page-head.tsx:4` — page title: `font-bold text-[28px] leading-tight tracking-[-0.025em]`
  - `components/overview.tsx:46` — stat number: `font-semibold text-[26px] leading-none tracking-[-0.02em] tabular-nums`
  - `components/ui/button.tsx:24` — `sm` size uses `text-[0.8rem]`; the base class uses `text-sm`
  - `components/ui/input.tsx:11` — `text-base ... md:text-sm`
  - Dialog titles: `font-semibold text-lg` (e.g. `components/delete-skill-dialog.tsx:47`)
  - Group headings and empty-state titles: `font-semibold text-base` (e.g. `routes/inbox.tsx:377`)
- Tailwind v4 lets a theme define named text sizes with a line height. A `--text-NAME` variable creates the utility `text-NAME`:

  ```css
  --text-body: 13px;
  --text-body--line-height: 20px;
  ```
- Project rule (from `AGENTS.md`): before committing, run `pnpm format`, then `pnpm lint`, and use Conventional Commits.

### The scale to add

| Token          | Size / line height                   | Use                                                      |
| -------------- | ------------------------------------ | -------------------------------------------------------- |
| `text-display` | 28px / 34px, letter-spacing -0.025em | Page titles (h1)                                         |
| `text-stat`    | 26px / 1, letter-spacing -0.02em     | Stat card numbers                                        |
| `text-heading` | 17px / 24px, letter-spacing -0.01em  | Group headings, dialog titles, empty-state titles        |
| `text-section` | 14px / 20px                          | Sub-section headings (h2 like `~/.claude/skills`)        |
| `text-lead`    | 14px / 20px                          | Page summary under the title                             |
| `text-body`    | 13px / 20px                          | Default UI text: row titles, paragraphs, buttons, inputs |
| `text-meta`    | 12px / 16px                          | Secondary lines, captions, hints, timestamps             |
| `text-micro`   | 11px / 14px                          | Chips, badges, counts                                    |

## Commands you will need

Run from the repo root (`dark-matter/`) unless noted.

| Purpose      | Command                                      | Expected on success                          |
| ------------ | -------------------------------------------- | -------------------------------------------- |
| Format       | `pnpm format`                                | exit 0                                       |
| Lint         | `pnpm lint`                                  | exit 0, "No fixes applied"                   |
| Typecheck    | `pnpm typecheck`                             | exit 0, no output after `$ tsc -b`           |
| Build        | `pnpm build`                                 | exit 0 (needed before e2e)                   |
| E2E          | `pnpm test:e2e`                              | 0 failed (43 passed, 1 skipped at plan time) |
| Visual check | see `docs/ui-plans/tools/capture.test.ts.txt` header | PNGs written to `$SHOT_DIR`                  |

## Scope

**In scope**:

- `packages/desktop/src/renderer/src/lib/utils.ts` (Step 0)
- `packages/desktop/src/renderer/src/styles.css`
- Every `*.tsx` under `packages/desktop/src/renderer/src/` **except** the out-of-scope list

**Out of scope**:

- `components/skill-preview.tsx` — renders the user's SKILL.md Markdown and keeps its own prose sizes (`text-xl`/`text-lg`/`text-base` headings, `text-[12px]` code). Leave it as is.
- `components/code-editor.tsx` — CodeMirror sizes are set in JS, not classes.
- Any colour, spacing, weight or layout change. This plan only renames sizes. Later plans change hierarchy.
- `packages/desktop/e2e/**` — tests use test ids and text, not classes.

## Git workflow

- Branch: `style/001-type-scale`
- Commit message, e.g.: `style(desktop): a named type scale for the renderer`
- Do NOT push or open a PR unless told to.

## Steps

### Step 0: Teach `cn` the new size names (do this first)

`cn` (package `cn`, a tailwind-merge replacement) treats unknown `text-*` names as **colours**. So `cn("text-body text-muted-foreground")` returns `"text-muted-foreground"` and silently drops the size. This was verified at plan time:

```text
cn("text-body text-muted-foreground")  → "text-muted-foreground"   ✗ size lost
cn("text-sm text-muted-foreground")    → "text-sm text-muted-foreground"
```

`packages/desktop/src/renderer/src/lib/utils.ts` is today exactly:

```ts
export { cn } from "cn";
```

Every renderer file imports `cn` from `@/lib/utils` (nothing imports `"cn"` directly). Replace the file with:

```ts
import { createCn } from "cn/config";

/** Class merging that knows the type scale in styles.css (`text-body` etc. are font sizes, not colours). */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "stat", "heading", "section", "lead", "body", "meta", "micro"] }],
    },
  },
});
```

**Verify**: from `packages/desktop`, run
`node -e 'import("cn/config").then(({createCn})=>{const cn=createCn({extend:{classGroups:{"font-size":[{text:["body","meta"]}]}}});console.log(cn("text-body text-muted-foreground"))})'`
→ prints `text-body text-muted-foreground`. Then `pnpm typecheck` (repo root) → exit 0.

If you ever add a token to the scale, add its name to this list too.

### Step 1: Add the tokens

In `styles.css`, inside `@theme inline { ... }`, right after the `--font-mono` line, add:

```css
  --text-display: 28px;
  --text-display--line-height: 34px;
  --text-display--letter-spacing: -0.025em;
  --text-stat: 26px;
  --text-stat--line-height: 1;
  --text-stat--letter-spacing: -0.02em;
  --text-heading: 17px;
  --text-heading--line-height: 24px;
  --text-heading--letter-spacing: -0.01em;
  --text-section: 14px;
  --text-section--line-height: 20px;
  --text-lead: 14px;
  --text-lead--line-height: 20px;
  --text-body: 13px;
  --text-body--line-height: 20px;
  --text-meta: 12px;
  --text-meta--line-height: 16px;
  --text-micro: 11px;
  --text-micro--line-height: 14px;
```

In `@layer base`, change `text-[13px]` on `body` to `text-body`.

**Verify**: `pnpm build` → exit 0. (The utility classes only appear in the built CSS once a component uses them; that's checked after Step 3.)

### Step 2: Migrate the one-off and named sizes

Make these exact replacements (in-scope files only):

| Find                                            | Replace with                      | Where                                                                                       |
| ----------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `text-[28px] leading-tight tracking-[-0.025em]` | `text-display`                    | `components/page-head.tsx`                                                                  |
| `font-semibold text-2xl tracking-tight`         | `font-bold text-display`          | `routes/first-run.tsx:61`, `routes/skill.tsx:38` (keep the other classes on those elements) |
| `text-[26px] leading-none tracking-[-0.02em]`   | `text-stat`                       | `components/overview.tsx`                                                                   |
| `text-lg`                                       | `text-heading`                    | all Dialog titles                                                                           |
| `font-semibold text-base`                       | `font-semibold text-heading`      | all h2s                                                                                     |
| `text-[0.8rem]`                                 | `text-body`                       | `components/ui/button.tsx` (`sm` size)                                                      |
| `text-base` … `md:text-sm`                      | `text-body` (delete `md:text-sm`) | `components/ui/input.tsx`                                                                   |
| `text-[14px]`                                   | `text-lead`                       | `components/sidebar.tsx` (brand name)                                                       |
| `text-[13px]`                                   | `text-body`                       | everywhere in scope                                                                         |
| `text-[12px]`                                   | `text-meta`                       | everywhere in scope                                                                         |
| `text-[11px]`                                   | `text-micro`                      | everywhere in scope                                                                         |

**Verify**: `cd packages/desktop/src/renderer/src && grep -rnE "text-\[[0-9.]+(px|rem)\]|text-(lg|xl|2xl|base)\b" --include='*.tsx' . | grep -v skill-preview.tsx` → no output.

### Step 3: Migrate `text-sm` and `text-xs`

- In `components/page-head.tsx`, the summary `<p>` → `text-lead`.
- Every other `text-sm` in scope → `text-body`.
- Every `text-xs` in scope → `text-meta`.
- The base string in `components/ui/button.tsx` contains `text-sm` → `text-body`.

Do it file by file, or with a careful scripted replace that only touches `text-sm` / `text-xs` as whole class tokens. **Do not** change `max-w-sm`, `rounded-sm`, `shadow-xs` or `max-w-xs`: those are not text classes.

**Verify**: `cd packages/desktop/src/renderer/src && grep -rnE "(^|[\" ])text-(sm|xs)([\" ]|$)" --include='*.tsx' . | grep -v skill-preview.tsx` → no output. Then `pnpm build` (repo root) and `grep -c "\.text-body" packages/desktop/out/renderer/assets/*.css` → at least 1 (if 0, that's the first STOP condition).

### Step 4: Check everything still builds and looks right

1. `pnpm format && pnpm lint` → exit 0.
2. `pnpm typecheck` → exit 0.
3. `pnpm build && pnpm test:e2e` → 0 failed.
4. Run the visual check (`docs/ui-plans/tools/capture.test.ts.txt`). Compare against a capture from `cabb160`: page titles and stat numbers look identical, list rows and paragraphs are now 13px (slightly smaller), and dialog titles and group headings are 17px. Nothing overlaps or wraps badly at 1360×860.

## Test plan

There are no unit tests for styling. The e2e suite (`pnpm test:e2e`) guards behaviour and text; the visual check guards looks. Don't add tests.

## Done criteria

- [ ] `pnpm lint` and `pnpm typecheck` exit 0
- [ ] `pnpm test:e2e` reports 0 failed
- [ ] The Step 2 and Step 3 grep checks print nothing
- [ ] `grep -c "\-\-text-" packages/desktop/src/renderer/src/styles.css` → 19
- [ ] `lib/utils.ts` uses `createCn` with all eight size names
- [ ] Only `lib/utils.ts`, `styles.css` and `*.tsx` files under `packages/desktop/src/renderer/src/` changed (`git status`); `skill-preview.tsx` and `code-editor.tsx` unchanged
- [ ] No `zz-capture.test.ts` left in `packages/desktop/e2e/`
- [ ] `docs/ui-plans/README.md` status row updated

## STOP conditions

- Tailwind does not generate a `text-body` utility after Step 1 (the build CSS has no `text-body`). Report the Tailwind version (`grep '"version"' packages/desktop/node_modules/tailwindcss/package.json`).
- A replacement would also need to change a non-size class (colour, weight, spacing) to look right. That belongs to plans 002/005.
- More than 3 e2e tests fail after Step 3. Size changes alone should not break tests.

## Maintenance notes

- The size names live in two places: `styles.css` (`--text-*`) and `lib/utils.ts` (`createCn` list). Add a new size to both, or `cn` will drop it whenever a colour class sits next to it.
- New UI must use these eight tokens. A reviewer should reject `text-[NNpx]`, `text-sm` or `text-xs` in new renderer code.
- Plan 002 changes how h2s and the page head use these tokens; plan 005 changes row text. Both assume this plan landed.
- `skill-preview.tsx` is deliberately left out: it renders user content.
