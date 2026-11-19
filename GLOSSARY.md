# Dark Matter

Dark Matter is a desktop manager and controller for the Agent Skills and MCP Servers that coding agents load, across a whole computer.

## Language

### Things being managed

**Skill**:
A folder whose entry point is a `SKILL.md` file, following the Agent Skills convention, that an Agent can load into its context.
_Avoid_: Plugin, prompt, command

**MCP Server**:
A Model Context Protocol server entry declared in an Agent's configuration, global or per Project.
_Avoid_: Tool server, integration

**Agent**:
A coding agent product that loads Skills and MCP Servers: in v1, Claude Code, Cursor, OpenCode, Codex, and the generic `.agents` convention.
_Avoid_: Client, assistant, harness

**Project**:
A codebase folder on disk whose Agents get their own set of Skills and MCP Servers.
_Avoid_: Workspace, repo

### Dark Matter's own concepts

**Library**:
The single canonical store of Skills that Dark Matter owns, at `~/.dark-matter`.
_Avoid_: Vault, cache, registry

**Adopt**:
To move an existing Skill from an Agent's folder into the Library, leaving a Link in its place.
_Avoid_: Import (reserved for pulling from a remote source), migrate

**Link**:
A symlink from an Agent's or Project's skill folder to a Skill in the Library.
_Avoid_: Shortcut, alias, mount

**Scan**:
A sweep of the computer that finds the Skills and MCP Servers every supported Agent can currently see.
_Avoid_: Index, crawl

**Namespace**:
The grouping a Library Skill belongs to, derived from its Source as `owner/repo`, or `local` when the Source is unknown.
_Avoid_: Category, folder, tag, Collection

**Source**:
Where a Skill came from: a GitHub repo, a skills.sh listing (which resolves to a repo), or local when Dark Matter can't tell.
_Avoid_: Origin, upstream, registry

**Library Lock**:
The single manifest that records every Library Skill's Source, pinned commit and content hash.
_Avoid_: Index, database, metadata file

**Name Conflict**:
Two Library Skills with the same name that are both wanted in the same Agent skill folder, where only one can be Linked.
_Avoid_: Collision, duplicate
