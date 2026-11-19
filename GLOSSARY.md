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
To move a Skill found by a Scan (in a global Agent folder, or untracked in a Project) into the Library, recording where it came from.
_Avoid_: Import (reserved for pulling from a remote source), migrate

**Project Skill**:
A Library Skill that a Project has added for its chosen Agents, delivered as either a Link or a Copy. It's the only way a Skill reaches an Agent.
_Avoid_: Enabled skill, installed skill

**Link**:
A Project Skill delivered as a symlink from the Project's skill folder to the Library. It's personal and never committed.
_Avoid_: Shortcut, alias, mount

**Copy**:
A Project Skill delivered as real files in the Project, committed and recorded in the Project's `skills-lock.json`, so teammates get it without Dark Matter.
_Avoid_: Vendor, snapshot, clone

**On / Off**:
The two states of a Project Skill. On means it's delivered to the Project's Agents. Off means it stays in the Project's Skill set but isn't delivered.
_Avoid_: Enabled/disabled, active/inactive

**Agent-managed Skill**:
A Skill an Agent installs and controls itself (a plugin Skill, a built-in or a bundled Skill), which Dark Matter can't move and can only turn off through the Agent's own settings.
_Avoid_: System skill, plugin skill, built-in

**Global Skill**:
A Skill sitting in an Agent's global folder, so every Project sees it. Dark Matter never creates one, and offers to Adopt any it finds.
_Avoid_: User skill, personal skill

**Vendored Skill**:
A Skill that is committed in a Project but that Dark Matter didn't create as a Copy. Dark Matter shows it but leaves it alone.
_Avoid_: Tracked skill, checked-in skill

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
