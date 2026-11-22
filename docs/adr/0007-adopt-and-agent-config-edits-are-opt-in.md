# Adopt and edits to Agent config are opt-in per Agent, and nothing is pre-selected

v1 offered to Adopt every Global Skill and Global MCP Server it found, and First run adopted all Global Skills behind one confirmation. It also wrote to Agents' own global config: it removed adopted entries from global MCP configs (ADR-0002 amendment) and turned Agent-managed Skills and MCP Servers off through each Agent's settings (`~/.claude/settings.json`, `~/.codex/config.toml`, OpenCode permissions). That is too aggressive by default. An Agent's global folders and config belong to that Agent and to whatever installed things there. A user who installs Dark Matter to look around shouldn't find their `~/.claude/skills` emptied or their `~/.codex/config.toml` rewritten.

So moving and editing become **opt-in, enforced in the core**:

- **Adopt Permission.** Each Agent has two switches in Settings: one for its Skills and one for its MCP Servers. Both are off by default for Claude Code, Cursor, OpenCode and Codex. Both are on for the generic `.agents` convention, because `~/.agents/skills` is the shared, tool-neutral folder that the user put there deliberately. A switch covers every folder that **Agent owns**: its global skill folder, its global MCP config, and its own folders inside a Project (`.claude/skills`, `.cursor/skills`, …). A Project's `.agents/skills` is always allowed. A folder belongs to exactly one Agent by its path (`~/.claude/skills` belongs to Claude Code even though Cursor and OpenCode also read it), so one switch decides it, however many Agents can see the folder.
- **Agent Config Guard.** One global setting, on by default. While it's on, Dark Matter never edits an Agent's global config. The off switches for Agent-managed Skills and MCP Servers are disabled, and no Global MCP Server can be adopted, because adopting one deletes its global entry. The MCP Adopt Permissions are greyed out until the Guard is off. What Dark Matter delivers into a Project isn't covered: Links, Copies, and Personal and Shared Project MCP Servers (including Claude Code's `projects[path].mcpServers` in `~/.claude.json`) are still written.
- **Nothing is pre-selected.** First run and the Inbox list everything a Scan finds. The user ticks what to move, sees the plan, and confirms. Items whose owning Agent doesn't allow Adopt are shown read-only, with the reason, and can't be ticked.
- **Undo is always allowed.** Undo Adopt puts things back where they came from, so it ignores the Adopt Permissions.

The Scan is unchanged: it still reads every Agent's folders and configs (read-only) and lists everything, including Agent-managed Skills and MCP Servers.

## Consequences

- Scanned items carry the owning Agent and whether they may be adopted. The Adopt plan is refused in the core (not just hidden in the app) when the owning Agent doesn't allow it, or when the Guard is on and the item is an MCP Server.
- Findings that can't be adopted stay visible in the Inbox as read-only, but don't trigger new-finding notifications from the Scheduled Scan.
- Existing users get the safe defaults on upgrade, because the new preferences have defaults in the settings schema. Skills and servers already in the Library stay there.
- First run's Adopt step is skipped when nothing can be ticked, and it carries an inline panel for the Adopt Permissions.
- ADR-0002's "offers to Adopt any it finds" now holds only where the owning Agent allows it. Its "switched off with the Agent's own disable setting" now holds only while the Agent Config Guard is off.

## Considered Options

- **Keep v1 behaviour, and add an "exclude" list.** Rejected: users would still have to discover the danger before protecting against it.
- **One switch per Agent that sees the folder.** Rejected: `~/.claude/skills` would be governed by three switches that could disagree.
- **Make `~/.agents/skills` the Library.** Rejected for the reasons in ADR-0001: it's flat, the `skills` CLI rewrites it, and several Agents read it directly.
