# The v1 stack uses Zod, tRPC and `node:sqlite` with no ORM, not Effect

The headless core (ADR-0003) needs a schema library for its RPC contracts and file parsing, an RPC layer over the loopback WebSocket, and a SQLite driver. t3code, which inspired the process model, uses Effect for all three (Effect Schema, Effect RPC and Effect SQL). We chose plain TypeScript instead: **Zod 4** schemas in `contracts`, **tRPC 11** over `ws`, and **`node:sqlite` with hand-written queries** plus numbered, forward-only `.sql` migrations tracked with `PRAGMA user_version`. The core is small and open source, and Effect costs contributors a lot to learn. Staying off Effect also keeps TanStack Query in the renderer, driven by a single tRPC `events` subscription that pushes invalidations.

## How it fits together

- `contracts` exports the tRPC router type and its Zod schemas. Typed errors use a small tagged-error convention, not Effect's error channel.
- `core` serves the router on 127.0.0.1 and checks the `core.json` token once per connection, through tRPC's `connectionParams`. The renderer, and later the CLI and the MCP shim, all use the same tRPC client.
- SQLite runs through `node:sqlite` (`DatabaseSync`), which is built into the Node that Electron ships (Node 24 in Electron 45). That means no native module and no rebuild per Electron version. PRAGMAs: WAL, `synchronous=NORMAL`, `busy_timeout`.

## Considered Options

- **Full Effect (Schema, RPC, SQL, layers), like t3code:** rejected. It's powerful, but it changes how every contributor writes the core, and it would replace TanStack Query with Effect atoms.
- **oRPC instead of tRPC:** rejected for now. Its auth is per call only, and we couldn't confirm that its streams work over its WebSocket link.
- **Drizzle ORM:** deferred, not rejected. Its `node:sqlite` driver exists only in the 1.0 pre-release (Nov 2026). Revisit once 1.0 is stable, if the schema outgrows hand-written queries.
- **Kysely:** rejected. It has no maintained `node:sqlite` dialect, so we'd have to maintain an adapter ourselves.
- **better-sqlite3:** rejected. It's a native module that needs rebuilding for each Electron version, and the built-in driver does the same job.
