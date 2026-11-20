# A headless Node core is the single writer, and Electron is one client of it

Dark Matter's logic lives in a **headless core**: a pure Node process with no Electron imports. It owns the Library, the Library Lock, Scans, Adopt, Link and Copy writes, watchers, the Scheduled Scan and SQLite. The core is the **only** process that writes any of these, and it holds `~/.dark-matter/core.lock` to guarantee that. Every surface is a client of the core: the Electron renderer, a future `dm` CLI, and the stdio MCP server that Agents launch. Every action is a core service method, so all surfaces share one code path. We chose this so that Agents can drive Dark Matter (feature 9) without the window open, and so that Adopt's moves, Link creation and atomic `~/.claude.json` edits never race each other.

## How it runs

- **Spawn:** Electron main starts the core as a child process, using Electron's own binary with `ELECTRON_RUN_AS_NODE=1`. Main supervises it (restarts it with backoff and stops it on quit). We don't use `utilityProcess`, because it exists only inside Electron.
- **Transport:** clients make typed RPC calls over a **loopback WebSocket** (127.0.0.1, random port) and authenticate with a per-run token. The core pushes events (scan progress, file changes) that drive TanStack Query invalidation. The core publishes its port and token in `~/.dark-matter/core.json` (mode 0600), which is how local clients find it. Electron IPC is used only for native things: dialogs, menus, notifications, the login item and updates.
- **Lifetime:** Dark Matter is a resident menu-bar (tray) app. Closing the window keeps it running. First run offers "Start at login", checked by default. The Scheduled Scan runs inside the core. If the app wasn't running at the scheduled time, the Scan catches up on the next start or wake.
- **Clients with no app running:** a CLI or MCP client that finds no running core starts a headless one itself (same entry point, detached, no window). That core takes the lock and exits after an idle timeout. If the app opens while one is running, the app attaches to it instead of spawning another. Quitting the app stops the core only if the app started it.
- **MCP for Agents:** a thin stdio shim that is just a core client. Consent and guardrails live in the core.
- **Packages:** `contracts` (RPC schemas), `core` (pure Node), and `desktop` (Electron main, preload, renderer). A `cli` package (CLI plus MCP shim) arrives with feature 9.

## Considered Options

- **Fat Electron main process:** rejected. Agent control and background work would need the window app, and every non-UI surface would have to go through Electron.
- **OS-scheduled job (launchd/systemd timer) for the Scheduled Scan:** deferred, not rejected. A resident menu-bar app avoids installing and upgrading OS services in v1. Because the core is already headless, a timer can be added later without changing it.
- **Always-on daemon installed as a user service:** rejected for v1 for the same reason.
- **Unix domain socket:** rejected because the renderer can't open one directly, so it would need main to relay traffic or a second transport.
