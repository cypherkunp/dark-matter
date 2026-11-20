# There are no global Skills: an Agent sees only the Skills its Project asks for

Every Agent supports global skill folders (`~/.claude/skills`, `~/.agents/skills`, `~/.cursor/skills`, `~/.config/opencode/skills`, `~/.codex/skills`), and the `skills` CLI defaults to filling them. Dark Matter deliberately never writes Skills there. A Skill reaches an Agent only as a **Project Skill**, delivered into that Project's skill folders as either a **Link** (a personal symlink to the Library, excluded from git) or a **Copy** (committed real files recorded in the Project's `skills-lock.json`), whichever the user picks for each Skill in each Project. The core idea of the product is that only the Skills a Project needs are ever in an Agent's context.

## Considered Options

- **Global plus per-Project overrides.** This was rejected. Every Project would inherit context it doesn't need, and Cursor has no native way to disable a single Skill per Project, so overrides can't be enforced everywhere.

## Consequences

- A Scan treats anything in a global folder as a **Global Skill** and offers to **Adopt** it. Adopting moves it into the Library (no trash, and the original path is recorded so it can be moved back); the user then adds it to the Projects that need it.
- Skills an Agent manages itself (Claude/Cursor plugins, Cursor built-ins, Codex `.system`) can't be moved. They're flagged, and switched off with the Agent's own disable setting where one exists.
- On/off has only Project scope (per Project, per Agent). There's no global toggle.
- A Skill wanted in ten Projects needs ten Project Skills. Bulk-adding (e.g. Collections) becomes more valuable.

## Amendment (2026-11-20): MCP Servers follow the same rule

An MCP Server costs context through its tool definitions, just as a Skill does, so there are no global MCP Servers either. Dark Matter never writes to a global MCP config (`~/.claude.json` top-level `mcpServers`, `~/.cursor/mcp.json`, the global `opencode.json`, `~/.codex/config.toml`). An MCP Server reaches an Agent only as a **Project MCP Server**, defined once in the Library and delivered into the Project as either **Personal** (Claude Code's local scope, or a git-excluded Project config file, with Secrets filled in from the keychain) or **Shared** (committed Project config, with Secrets only as environment-variable references).

- A Scan reports servers in global configs as **Global MCP Servers** and offers to Adopt them: the definition moves into the Library, inline secrets move into the keychain, and the entry is removed from the global config with a targeted, format-preserving edit that can be undone.
- On/Off removes or restores the delivered entry. Dark Matter doesn't use the Agents' native disable flags or lists, so the behaviour is the same everywhere, and Cursor's private state database is never written.
- Personal isn't available for an Agent whose Project config file is already tracked by git. In that case only Shared is offered for that Agent.
- **Considered and rejected:** managing a global MCP scope alongside Project scope, for servers used everywhere. This was rejected for the same reason as global Skills; bulk-adding is the remedy for repetition.
