# What t3code teaches about Electron stack and performance

Resolves [#5](https://github.com/cypherkunp/dark-matter/issues/5). Parent: [#1](https://github.com/cypherkunp/dark-matter/issues/1).

**Source studied:** [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at commit
[`2109962`](https://github.com/pingdotgg/t3code/tree/210996207d3c9327c1dcbb12cd958abdfa72e5ae)
(`210996207d3c9327c1dcbb12cd958abdfa72e5ae`, 2026-11-19). All file paths below are relative to that
commit; `T3/` is shorthand for
`https://github.com/pingdotgg/t3code/blob/210996207d3c9327c1dcbb12cd958abdfa72e5ae/`.

**Dark Matter starting stack:** Electron, shadcn/ui, TanStack Query, Biome, Vitest, SQLite.
Dark Matter needs to Scan the disk, Adopt Skills into the Library (`~/.dark-matter`), create and
watch Links, and later let Agents control it. That last point means the core should run without a
window.

## Answer in one paragraph

t3code is **not** an Electron app with a fat main process. It is a **headless Node server** (`t3`)
that owns all filesystem, process and database work. The **web UI talks to it over a typed Effect
RPC protocol on a WebSocket**. The **Electron app is a thin shell**: it spawns that same server as a
child process (Electron's own binary with `ELECTRON_RUN_AS_NODE=1`) and loads the web UI. The same
server can run alone (`npx t3`) and serve the web UI to a browser. That shape fits Dark Matter's
"Agents can control it" goal very well, so **keep the shape**. **Skip most of the heavy machinery**:
Effect everywhere, vite-plus/oxlint, event sourcing, a custom worker-thread SQLite client, 30+
packages. Dark Matter is a much smaller product.

## Summary table

| Area | What t3code does | Verdict for Dark Matter |
| --- | --- | --- |
| Monorepo and package manager | pnpm workspaces + catalogs, `apps/*` + `packages/*` (~35 packages) | **Adapt**: pnpm workspaces, 3 to 4 packages only |
| Process model | Electron main = shell; server is a separate child process; renderer = web app | **Keep** (the headless core) |
| Transport | Effect RPC over WebSocket for domain; small Electron IPC bridge for native-only things | **Adapt**: typed RPC over a local socket, schema-first contracts package |
| State and data fetching | Effect atoms (`@effect/atom-react`) + zustand; no TanStack Query; TanStack Router | **Adapt**: keep TanStack Query, push-invalidate from server events |
| Schema and validation | Effect `Schema` everywhere (contracts, config, errors) | **Adapt**: one schema lib (Zod 4 or Effect Schema) shared in a contracts package; skip full Effect |
| SQLite driver | Built-in `node:sqlite`, wrapped as an Effect `SqlClient`, reader/writer on worker threads, WAL | **Adapt**: `node:sqlite` (or better-sqlite3) in the server, copy the PRAGMAs, skip the worker client at first |
| Migrations | Numbered TS migration files run by Effect `Migrator` at startup | **Keep** the pattern (numbered, forward-only, run at boot) |
| DB location | `~/.t3/userdata/statev2.sqlite`, dir `0700`, dev uses a separate dir | **Keep**: `~/.dark-matter/` with a `dev` split |
| Build tooling | vite-plus (`vp`): Vite for web, tsdown (`vp pack`) for main/server, custom script driving electron-builder | **Adapt**: Vite + electron-vite (or tsdown) + electron-builder; skip the custom pipeline |
| Lint and format | oxlint + oxfmt via vite-plus, custom oxlint plugin, knip, `effect-tsgo` typecheck | **Skip** oxlint/oxfmt (Biome is the plan); **keep** knip and custom lint rules idea |
| Tests | Vitest (via vite-plus), `@effect/vitest`, Vitest browser mode with Playwright, render-count tests | **Keep** Vitest; **adapt** browser mode for list/scroll tests only |
| Performance | Virtualized lists, bounded snapshots, delta streaming, compile cache, startup profiler, render metrics, debounced watchers | **Keep** most ideas (see below) |
| Web/headless mode | Same server runs standalone (`t3`, `--mode web`, `headless` presentation) and serves the built web UI | **Keep**, and expose it to Agents through MCP |

---

## 1. Monorepo layout and package manager

**What t3code does**

- pnpm workspaces, pinned `packageManager: "pnpm@12.14.0"` and `engines.node: 26.13.1`
  (`T3/package.json`).
- `pnpm-workspace.yaml` lists `apps/*`, `packages/*`, `scripts`, `infra/*`, `evals`, and a
  custom lint plugin. It uses a pnpm **catalog** to pin shared versions (`effect: 4.1.3`,
  `react: 19.3.0`, `tailwindcss: 4.3.3`) and an `allowBuilds` allow-list for native install
  scripts (`node-pty`, `esbuild`, `sharp` allowed; `electron` handled by its own script).
- Apps: `apps/server` (the `t3` CLI and server), `apps/web` (React UI), `apps/desktop`
  (Electron shell), `apps/mobile` (React Native), `apps/marketing`.
- Packages that matter for the architecture: `packages/contracts` (every wire type),
  `packages/client-runtime` (connection and state logic shared by web and mobile, exported only
  through explicit subpaths), `packages/shared` (Node helpers such as the SQLite client). The other
  ~25 packages are provider and source-control adapters.

**Verdict: adapt.** pnpm workspaces with a catalog and an `allowBuilds` list is a good fit,
because Dark Matter will need native modules (SQLite, maybe a file watcher). But start with only:

- `apps/desktop`: Electron shell
- `apps/web`: React + shadcn/ui renderer
- `packages/core`: the headless server/daemon (Scan, Adopt, Link, watchers, DB)
- `packages/contracts`: shared schemas and RPC definitions

Add packages only when a second consumer shows up (for example a CLI or an MCP entry point). The
t3code rule "no root export, import explicit subpaths" (`T3/vite.config.ts`, restricted import of
`@t3tools/client-runtime`) helps tree-shaking. It is worth copying once `contracts` grows.

## 2. Process model

**What t3code does**

- `apps/desktop/src/boot.ts` loads a V8 compile cache, then `main.cjs`. The Electron main process
  handles windows, menus, updates, keychain and permissions. It does **not** do domain work.
- The main process **spawns the server as a child process**, using Electron's own binary as Node:
  `executablePath: process.execPath`, `ELECTRON_RUN_AS_NODE: "1"`
  (`T3/apps/desktop/src/backend/DesktopBackendConfiguration.ts`, around lines 558 to 575).
  No separate Node runtime ships.
- The boot config goes to the child over **file descriptor 3** (`--bootstrap-fd 3`). It carries a
  one-time bootstrap token and secret, so secrets never appear in argv or env. Extra fds (4 to 7)
  carry telemetry and browser-control channels.
- `T3/apps/desktop/src/backend/DesktopBackendManager.ts` supervises the child. It waits until
  `/.well-known/t3/environment` answers over HTTP (timeout 3 minutes, because big DB migrations
  are slow). It restarts with backoff (500 ms up to 10 s). On quit it sends SIGTERM, waits 5 s,
  then SIGKILLs, so a hung backend is never left running.
- The renderer is the normal web app. It connects to the local server's WebSocket like any
  remote client would. `docs/internals/overview.md`: "The desktop app bundles a server, but its
  renderer follows the same boundary."

**Verdict: keep.** This is the most valuable lesson for Dark Matter.

- Put Scan, Adopt, Link, file watching and SQLite in a **separate core process**, not in Electron
  main. A big Scan or a burst of watcher events then cannot freeze menus or window drag. A crash
  in the core can be restarted without killing the window.
- Spawning `process.execPath` with `ELECTRON_RUN_AS_NODE=1` avoids shipping a second Node.
  Electron's `utilityProcess` is a reasonable alternative if we want MessagePort IPC, but a plain
  child process keeps the core runnable outside Electron. That matters more for us.
- Copy the supervision rules: readiness probe, restart with backoff, SIGTERM then SIGKILL on quit,
  and secrets over an fd or stdin, not argv.
- Simplify: one core process, no backend pool, no WSL/SSH backends.

## 3. Transport

**What t3code does**

- **Domain traffic: Effect RPC over WebSocket.** The contract is one `RpcGroup` built from
  `effect/rpc` in `T3/packages/contracts/src/rpc.ts`. The server mounts it with
  `RpcServer` + `RpcSerialization.layerJson` (`T3/apps/server/src/ws.ts`, import at line 113,
  layer near line 3694). The client builds the protocol in
  `T3/packages/client-runtime/src/rpc/session.ts` (around line 264 to 292).
- Server-to-client updates are **RPC streams** (subscriptions). `T3/apps/server/src/rpcInitialItems.ts`
  sends a snapshot first, then live tail, and drops its reference to the snapshot once sent.
- The protocol is **versioned and capability-negotiated** (`ORCHESTRATION_PROTOCOL_VERSION`,
  `CLIENT_CAPABILITIES_QUERY_PARAM` imported in `ws.ts`). Old clients keep working with new servers.
- Bulk reads (history pages, cold snapshots) go over **plain HTTP**, not the socket
  (`docs/internals/performance-regressions.md`).
- **Electron IPC is kept to native-only work**: folder pickers, context menus, open-external,
  badges, updates, fullscreen (`T3/apps/desktop/src/ipc/channels.ts`). The bridge is a single
  `contextBridge.exposeInMainWorld("desktopBridge", …)` in `T3/apps/desktop/src/preload.ts`
  (line 106).

**Verdict: adapt.**

- Keep the split: **domain over RPC to the core, native UI over a small typed preload bridge.**
  Never let the renderer touch `fs`.
- Keep **one contracts package** that defines every method, its input, its output and its error.
  The core, the renderer and any later MCP or CLI front end all import it.
- Choose the RPC library based on the schema decision (section 5). If we stay with Zod and TanStack
  Query, a small tRPC-style or JSON-RPC layer over a WebSocket (or a Unix domain socket under
  `~/.dark-matter/`) is enough. We only need Effect RPC if we adopt Effect.
- Bind to loopback only, and require a token from day one. t3code had to retrofit pairing and
  scopes (`docs/internals/environment-auth.md`). Agents that control Dark Matter will be other
  local processes, so authentication matters even on localhost.
- Skip protocol versioning and capability negotiation for v1. Desktop and core ship together.
  Add it when a separately installed CLI or MCP client appears.

## 4. State management and data fetching

**What t3code does**

- **No TanStack Query.** `grep` finds zero imports of `@tanstack/react-query` in `apps/web/src`.
- Server state lives in **Effect atoms** (`@effect/atom-react`, imported in about 222 web files)
  fed by RPC streams. The shared logic is in `T3/packages/client-runtime/src/state/` (for example
  `threads-sync`, `shellReducer`, `threadHistoryController`).
- **zustand** (about 31 files) holds local UI state (command palette, closed views and so on).
- **TanStack Router** for routes (`@tanstack/react-router` + router plugin), and
  `@tanstack/react-pacer` for debounce and throttle.
- Client cache persistence writes at most every 10 s after a 500 ms settle
  (`T3/packages/client-runtime/src/state/cachePersistence.ts`).

**Verdict: adapt (keep TanStack Query).** t3code moved to push-based atoms because its data is a
high-rate event stream (agent tokens, terminal output). Dark Matter's data (Skills, MCP Servers,
Agents, Projects, Links) changes rarely and in bursts. Request/response fits it well.

- Use **TanStack Query** for reads (`listSkills`, `scanResults`, `agentConfigs`).
- Have the core **push small invalidation events** over the socket ("skill X changed", "scan
  finished") and call `queryClient.invalidateQueries` or `setQueryData`. That gives live updates
  without building a reactive store.
- Use **zustand only for local UI state**, if React state is not enough.
- Consider **TanStack Router**. It is in the same family and t3code uses it with success.

## 5. Schema and validation

**What t3code does**

- **Effect 4** (`effect: 4.1.3` in the catalog) is used everywhere: services and layers, the
  child-process spawner, `FileSystem`, HTTP, SQL, RPC, and `Schema` for every contract, config,
  bootstrap message and tagged error (`Schema.TaggedError` in
  `T3/apps/server/src/persistence/Sqlite.ts`). Typecheck runs `effect-tsgo` (Effect's language
  service on the TS 7 Rust checker).
- Zod 4 still appears in the server for SDK interop (`apps/server/package.json`).

**Verdict: adapt, and decide in an ADR.** Effect gives t3code typed errors, structured concurrency
(scopes clean up watchers and child processes), and one schema for both RPC and SQL. Those are
real wins for a watcher-heavy daemon. But Effect is a big learning cost for an open-source app
that wants contributors, and t3code's own `AGENTS.md` asks contributors to avoid machinery that
"looks architecturally impressive".

Recommendation: **Zod 4 schemas in `packages/contracts`**, used at every boundary (RPC, config
files we parse such as `.mcp.json`, `SKILL.md` frontmatter, DB rows). Plain async TypeScript in the
core, with explicit `AbortController` and dispose patterns for watchers. Revisit Effect only if
resource cleanup and error handling turn into a real problem.

## 6. SQLite driver, migrations and DB location

**What t3code does**

- **Driver:** Node's built-in **`node:sqlite`**, wrapped as an Effect `SqlClient` in
  `T3/packages/shared/src/nodeSqliteClient.ts`. It runs a **reader worker and a writer worker**
  (`node:worker_threads`), so a slow disk "delays writes instead of freezing every client"
  (`T3/apps/server/src/persistence/Sqlite.ts`, around line 110). No native addon is needed, so
  there are no electron-rebuild problems.
- **PRAGMAs at open** (`Sqlite.ts`, around lines 70 to 95): `busy_timeout = 5000` (CLI and server
  share the DB), `foreign_keys = ON`, `auto_vacuum = INCREMENTAL` for new DBs, `journal_mode = WAL`,
  `synchronous = NORMAL`, `checkpoint_fullfsync = ON` (macOS fsync does not flush drive caches),
  `temp_store = MEMORY`, `journal_size_limit = 128 MiB`, then refresh `sqlite_stat1`.
- **Damaged DB handling:** SQLITE_CORRUPT and SQLITE_NOTADB are turned into a clear message that
  tells the user which files to move away (`Sqlite.ts`, `damagedDatabaseError`).
- **Single owner:** an ownership lock (a held `server-owner.sqlite` handle, `apps/server/src/serverOwnership.ts`) stops a second process (for example the CLI)
  from migrating a DB that a running server owns.
- **Migrations:** 128 numbered TS files in `T3/apps/server/src/persistence/Migrations/`
  (`001_OrchestrationEvents.ts` …), registered in order in `Migrations.ts` and run by Effect's
  `Migrator` at startup. Each file is plain SQL in a tagged template with `IF NOT EXISTS`. The
  desktop shows "migrating" progress while it waits (`isRunningDatabaseMigrations` in
  `DesktopBackendManager.ts`).
- **Location:** `<T3 home>/userdata/statev2.sqlite` (`T3/apps/server/src/config.ts`, lines
  147 to 151). T3 home is `~/.t3` by default. Dev uses `<home>/dev` instead of `userdata`. The state
  dir is `chmod 0700` and marked no-copy-on-write before the DB is created (`config.ts`, around
  lines 183 to 206). Settings, keybindings and secrets are JSON files next to the DB, not rows.
- **Data model:** event-sourced (`orchestration_events` table plus projection tables).

**Verdict: adapt.**

- **Keep:** SQLite **in the core process only**. Copy the PRAGMA set, the damaged-DB message, the
  single-owner lock and the startup migration runner with numbered, forward-only files.
- **Keep:** DB at `~/.dark-matter/state.sqlite` (next to the Library), a separate dev home, a
  `0700` dir. Never point dev or tests at the real home (t3code's `AGENTS.md` lists "writing to the
  live install" as one of three ways to hurt yourself).
- **Driver:** prefer **`node:sqlite`**, which ships with the Node inside Electron, so there is no
  native rebuild. Fall back to `better-sqlite3` only if we hit a missing feature. Use a small
  migration runner (or Drizzle/Kysely migrations) instead of Effect `Migrator`.
- **Skip:** event sourcing and the worker-thread client. For Dark Matter, **the filesystem is the
  source of truth**. SQLite is an index and cache of Scan results plus Library metadata. A single
  connection with WAL is enough at first. Move writes to a worker only if profiling shows
  event-loop stalls.

## 7. Build tooling and packaging

**What t3code does**

- **vite-plus** (`vp`) drives everything: `vp dev` and `vp build` for the web app (Vite), and
  `vp pack` (tsdown) to bundle the Electron main and the server
  (`T3/apps/desktop/vite.config.ts`, `T3/apps/server/vite.config.ts`). `vp run` is the task runner
  with caching and `dependsOn` (for example desktop `build` depends on `t3#build`).
- The **server is bundled with its dependencies inlined**. Only a short list of runtime externals
  is installed into the app (`scripts/lib/desktop-external-packages.ts`).
- **Packaging:** `electron-builder 26` driven by a large custom script,
  `T3/scripts/build-desktop-artifact.ts` (dmg for mac arm64/x64, AppImage for Linux, NSIS for Windows),
  plus `@electron/asar` checks that the bundle is self-contained. `electron-updater` handles
  updates. Electron is pinned at `44.10.1`.
- The server can also be built as a single executable (`build:exe`, Node SEA via tsdown).

**Verdict: adapt.**

- **Keep:** Vite for the renderer, a bundler for main/preload/core, **electron-builder** with dmg
  (mac) and AppImage/deb (Linux), and `electron-updater`. Bundle the core with its dependencies
  inlined, so `node_modules` in the app stays tiny. That also speeds up startup.
- **Use electron-vite** (or tsdown for main and core) instead of vite-plus. vite-plus is new and
  pulls in its own lint, format and test stack, which clashes with the Biome decision.
- **Skip:** the 4,200-line custom artifact script, Windows/WSL paths, the SEA build. Use the
  plain electron-builder config until something forces a script.

## 8. Lint, format and test setup

**What t3code does**

- **Lint:** oxlint through `vp lint`, with plugins `eslint, oxc, react, unicorn, typescript`, plus
  JS plugins `./oxlint-plugin-t3code` (custom rules) and `@shadcn/lint` (`T3/vite.config.ts`,
  around lines 215 to 234). Custom rules ban test anti-patterns
  (`no-wall-clock-in-tests`, `no-polling-loop-in-tests`, `no-test-timeout-or-unreasoned-skip`) and
  enforce `no-restricted-imports` (for example "use LegendList, not FlatList", "render the
  `components/ui` export instead of borrowing `buttonVariants`").
- **Format:** oxfmt through `vp fmt`. Staged-file checks through `vp` `staged` config.
- **Dead code:** `knip` with a CI check.
- **Typecheck:** `effect-tsgo tsrs --noEmit` per package, cached.
- **Tests:** Vitest through vite-plus. `@effect/vitest` for Effect code (`it.effect` with a
  `TestClock`). The web app has a `unit` project and a `browser` project (Vitest browser mode with
  Playwright Chromium, `*.browser.test.tsx`; `T3/apps/web/vite.config.ts`, around lines 93 to 145).
  A `renders` project counts React commits per scenario (`T3/scripts/render-metrics.ts`).
  `check:changed` runs only checks for changed files before a push.

**Verdict: mixed.**

- **Skip** oxlint and oxfmt. Biome covers lint and format in one tool and is already the plan.
- **Keep** the idea of **restricted imports** for design-system rules (Biome has
  `noRestrictedImports`). For example, ban direct `fs` in the renderer and ban borrowing shadcn
  variant helpers.
- **Keep** `knip` for dead code and dependencies.
- **Keep** Vitest. Add a **browser-mode project only** for virtualized list and scroll behavior;
  everything else stays as fast unit tests. Copy the test rules: no sleeps, no polling, no
  wall-clock deltas; wait on events. That matters a lot for watcher tests. Use temp dirs for every
  filesystem test, never the real home.
- **Adapt** `check:changed` as a simple pre-push script later.

## 9. Performance techniques

t3code's `AGENTS.md` says: "We regularly audit for performance regressions, often caused by
sending too much data over websockets, css animations causing gpu spikes, lists being hard to
render." What it does:

| Technique | Where | Verdict |
| --- | --- | --- |
| **Heavy work off the UI process.** Server is a child process; SQLite reader/writer on worker threads | `DesktopBackendConfiguration.ts`, `nodeSqliteClient.ts` | **Keep** the process split; workers only when profiling asks |
| **Virtualized lists** with `@legendapp/list` (about 23 web files), enforced by lint on mobile | `apps/web/src`, `T3/vite.config.ts` restricted imports | **Keep**: virtualize Skill and MCP Server lists (`@tanstack/react-virtual` or LegendList) |
| **Bounded payloads.** Cold opens stop near 1 MiB or a row cap; older data in HTTP pages; bodies dropped at the wire | `docs/internals/performance-regressions.md` | **Keep**: page Scan results; never ship file contents in list responses |
| **Snapshot then deltas** on subscribe; resume sends deltas only | `apps/server/src/rpcInitialItems.ts`, same doc | **Adapt**: send "changed ids", let Query refetch |
| **Payload budget tests** that fail locally | `test:perf:v2-wire` in `T3/package.json`, `apps/server/integration/transferBudgetV2.integration.test.ts` | **Adapt** later: one test that caps a Scan response for a big fixture tree |
| **Render-count tests** (React commits per scenario, compared before/after) | `T3/scripts/render-metrics.ts`, web `renders` Vitest project | **Adapt** later, once the UI is stable |
| **Startup:** V8 compile cache (`node:module.enableCompileCache`) for main and server | `T3/apps/desktop/src/compileCache.ts`, `apps/server/src/compileCache.ts` | **Keep**: cheap, a few lines |
| **Startup profiler** via `--import` hook writing CPU profiles and module timings | `T3/scripts/profile-startup.mjs` (`pnpm profile:startup`) | **Keep** the idea; add when we measure startup |
| **Bundled server** so few files are read from `node_modules` at boot | section 7 | **Keep** |
| **File watching** with `fs.watch` on the **parent directory** (survives rename-replace saves), re-watch when a directory is replaced, and restart a watch that ended | `T3/apps/server/src/serverSettings.ts` (around lines 1280 to 1300), `T3/apps/server/src/vcs/VcsStatusBroadcaster.ts` (around line 1057) | **Keep**: very relevant to watching Agent skill folders and Links |
| **Throttled output streams** (one bounded tail per command, throttled per subscriber) | `apps/server/src/orchestration-v2/CommandOutputHub.ts` | **Adapt**: coalesce watcher bursts before invalidating |
| **Debounced persistence** (500 ms settle, 10 s cadence) | `packages/client-runtime/src/state/cachePersistence.ts` | **Keep** for any client cache |
| **SQLite tuning** (WAL, `synchronous=NORMAL`, `temp_store=MEMORY`, WAL size cap) | `apps/server/src/persistence/Sqlite.ts` | **Keep** |
| **Native helper** in Rust for resource monitoring | `native/resource-monitor` | **Skip** |

Notes for Dark Matter specifically:

- **Watchers:** t3code uses plain `fs.watch` (through Effect's `FileSystem.watch`), not chokidar
  or `@parcel/watcher`. It watches parent directories because editors and git save by
  rename-replace. Dark Matter watches many Agent folders and must notice when a Link's target
  moves. Copy the "watch the parent, follow the link target's directory" pattern. Benchmark
  `@parcel/watcher` (FSEvents on macOS, inotify on Linux) if the number of watched folders grows
  large. Linux inotify watch limits will be a real constraint there.
- **Scan:** run it in the core, stream progress events, write results in batched transactions, and
  never block the RPC loop on a full-disk walk.

## 10. Web and headless mode

**What t3code does**

- The server is a standalone CLI, `t3` (`apps/server/package.json` `bin`, `apps/server/src/bin.ts`).
  `npx t3@latest` starts it and opens the web app in a browser (`T3/README.md`).
- `RuntimeMode = "web" | "desktop"` and `StartupPresentation = "browser" | "headless"`
  (`T3/apps/server/src/config.ts`, lines 32 to 36). The desktop passes `mode: "desktop"`,
  `noBrowser: true`.
- In web mode the server **serves the built web UI itself** (`resolveStaticDir` in `config.ts`
  around line 278, used in `http.ts` around line 561). The bundled client sits next to the server
  in `dist/client`, or falls back to `apps/web/dist` in the monorepo.
- The web UI checks for the desktop bridge (`window.desktopBridge`) and falls back to web
  behavior without it. All domain work goes through RPC either way.
- **Agents control the app through MCP.** The server has its own MCP HTTP server
  (`T3/apps/server/src/mcp/McpHttpServer.ts`). Its `AGENTS.md` rule: "A capability a user can trigger
  is usually one an agent should reach through MCP tools … That only works when it is a service
  method, not handler code."

**Verdict: keep.** This maps directly onto Dark Matter's "Agents can control it" requirement.

- Build `packages/core` so it starts with **no Electron at all** (`node core.js --home ~/.dark-matter`).
  Electron is only one client of it.
- Put every user action (Scan, Adopt, Link, enable an MCP Server) in a **core service method**.
  RPC handlers, a future CLI and a future **MCP server for Agents** then call the same function.
- Optional and later: let the core serve the built renderer for a browser UI. It is cheap once the
  renderer only talks RPC, but it is not a v1 need.
- Skip remote access (Tailscale, relay, pairing across machines). Dark Matter manages one
  computer.

---

## Recommended Dark Matter architecture (from these lessons)

```
apps/desktop  (Electron main + preload)  ── spawns ──▶  packages/core  (Node, headless)
      │  small typed IPC bridge: dialogs, menus, open-external         │  Scan, Adopt, Link, watchers
      ▼                                                                │  SQLite (node:sqlite, WAL)
apps/web  (React, shadcn/ui, TanStack Query/Router) ◀── typed RPC over │  ~/.dark-matter/state.sqlite
                                                        loopback WS ──┘  later: MCP server, CLI
packages/contracts  (Zod schemas + RPC method definitions, shared by all)
```

## Follow-up decisions this feeds

- ADR: core as a separate process (child process via `ELECTRON_RUN_AS_NODE`) vs `utilityProcess`.
- ADR: Effect vs Zod plus plain TypeScript for the core and contracts.
- ADR: SQLite driver (`node:sqlite` vs `better-sqlite3`) and migration runner.
- Spike: watcher library for many Agent folders and Links on macOS and Linux (`fs.watch` vs
  `@parcel/watcher`).
