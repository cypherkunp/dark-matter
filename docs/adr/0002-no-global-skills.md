# There are no global Skills: an Agent sees only the Skills its Project asks for

Every Agent supports global skill folders (`~/.claude/skills`, `~/.agents/skills`, `~/.cursor/skills`, `~/.config/opencode/skills`, `~/.codex/skills`), and the `skills` CLI defaults to filling them. Dark Matter deliberately never writes Skills there. A Skill reaches an Agent only as a **Project Skill**, delivered into that Project's skill folders as either a **Link** (a personal symlink to the Library, excluded from git) or a **Copy** (committed real files recorded in the Project's `skills-lock.json`), whichever the user picks for each Skill in each Project. The core idea of the product is that only the Skills a Project needs are ever in an Agent's context.

## Considered Options

- **Global plus per-Project overrides.** This was rejected. Every Project would inherit context it doesn't need, and Cursor has no native way to disable a single Skill per Project, so overrides can't be enforced everywhere.

## Consequences

- A Scan treats anything in a global folder as a **Global Skill** and offers to **Adopt** it. Adopting moves it into the Library (no trash, and the original path is recorded so it can be moved back); the user then adds it to the Projects that need it.
- Skills an Agent manages itself (Claude/Cursor plugins, Cursor built-ins, Codex `.system`) can't be moved. They're flagged, and switched off with the Agent's own disable setting where one exists.
- On/off has only Project scope (per Project, per Agent). There's no global toggle.
- A Skill wanted in ten Projects needs ten Project Skills. Bulk-adding (e.g. Collections) becomes more valuable.
