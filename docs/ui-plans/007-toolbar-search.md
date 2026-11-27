# Plan 007: The toolbar offers ⌘K search and shows a breadcrumb only on detail screens

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `docs/ui-plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat cabb160..HEAD -- packages/desktop/src/renderer/src/components/header.tsx packages/desktop/src/renderer/src/components/command-palette.tsx packages/desktop/src/renderer/src/nav.ts`
> Plan 001 may have renamed size classes in these files (`text-[13px]` →
> `text-body`, `text-xs` → `text-meta`). Any other change: compare with
> "Current state" and STOP on a mismatch.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: docs/ui-plans/001-type-scale.md (uses `text-body`, `text-micro`)
- **Category**: direction (UI)
- **Planned at**: commit `cabb160`, 2026-11-27

## Why this matters

On most screens the toolbar repeats the page title: "Library › All Skills" sits right above the H1 "All Skills", and "Inbox" right above "Inbox". Meanwhile the app's best navigation tool, the ⌘K command palette (jump to any Skill, Namespace, Collection or Project, or run an action), is invisible unless you know the shortcut. The design reference puts a centred "Search… ⌘K" field in the toolbar. After this plan the toolbar centre opens the palette, and the breadcrumb shows only where it adds information: the Skill, Namespace, Collection and Project detail screens.

## Current state

`packages/desktop/src/renderer/src/components/header.tsx` at `cabb160`:

```tsx
export function Header() {
  ...
  const crumbs = breadcrumbFor(location.pathname, location.search);
  return (
    <header className="dark drag-region flex h-[52px] shrink-0 items-center gap-3 px-4 text-foreground">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px]">
        {crumbs.map((crumb, index) => ( … ChevronRight separators … ))}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        {library.dataUpdatedAt > 0 && (
          <span className="text-muted-foreground text-xs">Updated {relativeTime(library.dataUpdatedAt, now)}</span>
        )}
        <Button size="sm" className="no-drag px-3.5" disabled={scanning} onClick={scan}> … Scan now … </Button>
      </div>
    </header>
  );
}
```

- The header has the `dark` class, so tokens inside it resolve to dark values (it sits on the near-black window chrome). `drag-region` makes it drag the window; interactive children need `no-drag`.
- `packages/desktop/src/renderer/src/components/command-palette.tsx` keeps its own `open` state and opens on ⌘K/Ctrl+K:

  ```tsx
  export function CommandPalette() {
    const [open, setOpen] = useState(false);
    ...
    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          setOpen((current) => !current);
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, []);
  ```

  It's rendered once, in `routes/__root.tsx`.
- `packages/desktop/src/renderer/src/nav.ts:71` `breadcrumbFor(path, search)` builds the crumbs. The detail paths are `/skill`, `/namespace`, `/collection`, `/project`.
- E2E relying on this: `e2e/skill-page.test.ts:38,50` assert the Breadcrumb navigation on `/skill` and `/namespace` (`getByRole("navigation", { name: "Breadcrumb" })`). Tests open the palette with `window.keyboard.press("ControlOrMeta+k")`. No test looks for a button named "Search".

## Commands you will need

Run from the repo root.

| Purpose      | Command                                                                                                               | Expected on success |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Format, Lint | `pnpm format && pnpm lint`                                                                                            | exit 0              |
| Typecheck    | `pnpm typecheck`                                                                                                      | exit 0              |
| Build + E2E  | `pnpm build && pnpm test:e2e`                                                                                         | 0 failed            |
| Focused e2e  | `cd packages/desktop && npx playwright test e2e/skill-page.test.ts e2e/collections-mcp.test.ts e2e/skills-sh.test.ts` | all pass            |

## Scope

**In scope**: `components/header.tsx`, `components/command-palette.tsx`, `packages/desktop/e2e/smoke.test.ts` (one new assertion).

**Out of scope**: `nav.ts` (`breadcrumbFor` stays as is), the palette's search and results, the sidebar filter field.

## Git workflow

- Branch: `feat/007-toolbar-search`
- Commit e.g.: `feat(desktop): ⌘K search in the toolbar; breadcrumb only on detail screens`

## Steps

### Step 1: Let other components open the palette

In `command-palette.tsx`, add above `CommandPalette`:

```ts
const OPEN_EVENT = "dark-matter:open-command-palette";

/** Open the ⌘K command palette from anywhere (e.g. the toolbar search field). */
export const openCommandPalette = () => window.dispatchEvent(new Event(OPEN_EVENT));
```

Inside the existing `useEffect` that adds the keydown listener, also listen for it:

```ts
const onOpen = () => setOpen(true);
window.addEventListener(OPEN_EVENT, onOpen);
// and in the cleanup:
window.removeEventListener(OPEN_EVENT, onOpen);
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Rebuild the header layout

In `header.tsx`:

1. Imports: add `Search` from `lucide-react` and `openCommandPalette` from `./command-palette`.
2. Add, at module level:

   ```ts
   /** Screens whose breadcrumb says more than their title does. */
   const detailPaths = new Set(["/skill", "/namespace", "/collection", "/project"]);
   const shortcut = navigator.userAgent.includes("Mac") ? "⌘K" : "Ctrl K";
   ```
3. Make the `<header>` a three-column grid: replace `flex … items-center gap-3` with `grid grid-cols-[1fr_auto_1fr] items-center gap-3` (keep `dark drag-region h-[52px] shrink-0 px-4 text-foreground`).
4. Column 1: wrap the existing `<nav aria-label="Breadcrumb">` in `<div className="min-w-0">`, and render the nav only when `detailPaths.has(location.pathname)`. Add `min-w-0 truncate` to the nav.
5. Column 2, new:

   ```tsx
   <button
     type="button"
     onClick={openCommandPalette}
     className="no-drag flex h-8 w-[min(26rem,40vw)] items-center gap-2 rounded-full bg-white/[0.07] px-3 text-body text-muted-foreground transition-colors hover:bg-white/[0.11] hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
   >
     <Search className="size-3.5 shrink-0" />
     <span className="truncate">Search Skills, Projects and actions…</span>
     <kbd className="ml-auto rounded-md bg-white/[0.08] px-1.5 font-sans text-micro">{shortcut}</kbd>
   </button>
   ```
6. Column 3: the existing right-hand group; replace its `ml-auto` with `justify-self-end`.

**Verify**: `pnpm typecheck` → exit 0. `pnpm build && cd packages/desktop && npx playwright test e2e/skill-page.test.ts` → passes (the breadcrumb still shows on `/skill` and `/namespace`).

### Step 3: Cover the new button in the smoke test

In `packages/desktop/e2e/smoke.test.ts`, in the test `"renders the shell in light and dark mode"`, after `await expect(window.getByTestId("library-empty")).toBeVisible();` add:

```ts
// The toolbar search opens the command palette; no breadcrumb on a top-level screen.
await expect(window.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
await window.getByRole("button", { name: /Search Skills, Projects and actions/ }).click();
await expect(window.getByTestId("command-palette")).toBeVisible();
await window.keyboard.press("Escape");
await expect(window.getByTestId("command-palette")).toBeHidden();
```

**Verify**: `pnpm build && cd packages/desktop && npx playwright test e2e/smoke.test.ts` → all pass.

### Step 4: Check

`pnpm format && pnpm lint`, `pnpm typecheck`, `pnpm build && pnpm test:e2e` → all pass.
Visual check: on `/library` the toolbar shows the centred search pill and no breadcrumb. On a Skill page, the breadcrumb is on the left and truncates before it reaches the search pill. Window dragging still works from the empty toolbar areas (manual: `pnpm dev`, drag by the toolbar).

## Done criteria

- [ ] `openCommandPalette` exported from `command-palette.tsx`
- [ ] `grep -n "detailPaths" packages/desktop/src/renderer/src/components/header.tsx` → matches
- [ ] Smoke test has the new assertions and passes
- [ ] `pnpm lint`, `pnpm typecheck` exit 0; `pnpm test:e2e` 0 failed
- [ ] `docs/ui-plans/README.md` status row updated

## STOP conditions

- `e2e/skill-page.test.ts` fails on a breadcrumb assertion for a path not in `detailPaths`. Report the path; don't widen the set by guessing.
- Clicking the search button drags the window instead of opening the palette (`no-drag` not applied).
- On a window narrower than ~900px the three columns overlap. Report with a screenshot rather than hiding elements.

## Maintenance notes

- New detail screens (a URL that identifies one item) should be added to `detailPaths`.
- Anything that wants to open the palette should call `openCommandPalette()`, not duplicate its state.
