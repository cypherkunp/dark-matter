# Files are the source of truth; SQLite is a disposable cache

Everything Dark Matter knows is either already on disk where it doesn't own it, or is intent that exists nowhere else. Examples of the first are Skill folders, Links and Copies, each Project's `skills-lock.json`, Agent configs and the `skills` CLI's lock files. Examples of the second are which Projects you confirmed, an Off Project Skill, your Favourites and your settings. We keep **all owned intent in small, human-readable JSON files under `~/.dark-matter`**. SQLite (`state/dark-matter.db`) holds only data derived from those files and from disk, plus ephemeral results. The invariant is: **deleting `~/.dark-matter/state/` loses nothing; the next start rebuilds it.** We chose this over keeping intent in SQLite for three reasons. The db never becomes precious, so it needs no backups. Every piece of state can be read, diffed and repaired with a text editor. And the layout stays git-friendly for a later device sync.

## Where each thing lives

| Location | Holds |
|---|---|
| `library-lock.json` | Portable provenance per Library Skill (ADR-0001), which is also where Sources come from: `source`, tracked `ref`, pinned `commit`, `computedHash`, plus `adoptedFrom` (for Undo Adopt) and a Local Source's target. Paths here are home-relative (`~/…`), and an absolute path is allowed only as a flagged, non-portable fallback. |
| `projects.json` | Confirmed Projects (keyed by absolute path, so machine-specific), each with its chosen Agents and its Project Skills (Library Skill key, Link or Copy, On or Off). |
| `settings.json` | Preferences (Scheduled Scan time, login item, trash and Activity Log retention), Favourites (Skills and Sources), ignored Inbox findings, and dismissed Suggested Projects. |
| `activity/YYYY-MM-DD.jsonl` | The Activity Log: append-only, with files older than the retention setting deleted (default 30 days). |
| OS keychain | Secrets and the GitHub PAT. |
| `state/dark-matter.db` | Cache only: Scan results, Inbox findings, Sources grouped from the lock, update-check results (last head seen, rate limit, auth status), hash and mtime caches, and the Activity Log index. |

MCP Server state follows the same rule (ADR-0002 amendment): Library MCP Server definitions and Project MCP Servers are owned intent, so they live in files, not the db.

## Rules

- The core (ADR-0003) is the only writer. Every write is atomic (temp file plus rename), with sorted keys and no volatile fields, so diffs stay quiet.
- **Hand edits are tolerated.** The core watches its own files and re-validates them against the `contracts` Zod schemas. If a file is invalid, the core keeps the last good state, shows an error, and never overwrites your edit until you fix it or discard it.
- **The cache is never migrated.** This refines ADR-0004's forward-only migrations for this one db: on a `user_version` mismatch, or a missing or corrupt db, the core drops it and rebuilds from the files plus a full Scan. On a normal start, the core serves the cache immediately and catches up with a background Scan.
- How drift between owned intent and disk is detected and repaired (a hand-deleted Link, a teammate's `skills-lock.json` change) is a separate decision.

## Considered Options

- **Intent in SQLite, with only the Library Lock as a file:** rejected. It's easier to query, but the db becomes the only copy of your Projects and toggles, so it would need migrations and backups. It also can't be inspected or synced as text.
- **No SQLite at all:** rejected. Scan results, Inbox findings and the Activity Log across many Projects want indexed queries, and the UI wants instant start-up from a cache.
- **Activity Log as a SQLite table:** rejected. The log is history you rely on for 30 days, and a cache that rebuilds by dropping itself must not hold it.
