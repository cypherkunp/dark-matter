# The Library is separate from `~/.agents/skills`, and Skill folders stay untouched

The `skills` CLI already uses a canonical store plus symlinks: one real copy in `~/.agents/skills`, with agent folders symlinked to it. Aligning with it was the obvious choice. We still keep Dark Matter's Library at `~/.dark-matter/skills/<namespace>/<name>/`, for three reasons: `~/.agents/skills` is flat, so it can't hold Namespaces or two Skills with the same name; the CLI rewrites it (`npx skills add -g` deletes and recreates links there); and Cursor, Codex and OpenCode read it directly as an Agent folder. So `~/.agents/skills` is treated as one more Agent skill folder. Per [ADR-0002](0002-no-global-skills.md), it receives no Links, because there are no global Skills.

Provenance lives in a single `~/.dark-matter/library-lock.json`, whose entries use the skills-lock v2 shape, and never in sidecar files inside a Skill folder. Agents follow Links, so anything written inside a Skill folder would leak into Agent context and change the Skill's computedHash.

## Consequences

- Dark Matter has to coexist with the `skills` CLI adding Skills to global folders (`npx skills add -g`) or to Project folders. Scan must detect this and offer to Adopt.
- Because the manifest uses the lock v2 shape, comparing a Library Skill with any Project's `skills-lock.json` is a direct match on hash and source.
