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

**Import**:
To fetch chosen Skills from a GitHub repo (directly or through a skills.sh listing) into the Library, pinned to an exact commit and following a ref for updates.
_Avoid_: Install, clone, add (reserved for adding a Skill to a Project)

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
A read-only sweep of the computer that finds the Skills and MCP Servers every supported Agent can currently see. It never changes anything; Adopt does.
_Avoid_: Index, crawl, sync

**Scheduled Scan**:
A Scan that runs automatically each day at a configurable time and tells you about new Global Skills.
_Avoid_: Cron, background sync

**Suggested Project**:
A folder that some Agent's history shows was worked in, which Dark Matter offers to manage. It becomes a Project only once you confirm it.
_Avoid_: Detected project, recent workspace

**Inbox**:
The screen that collects every Scan finding still waiting on your decision: Global Skills and untracked Project Skills to Adopt, Agent-managed Skills you might turn off, and Suggested Projects.
_Avoid_: Notifications, queue, review list

**Favourite**:
A star you put on a Skill or on a Source. The Favourites view shows starred Skills plus every Library Skill from a starred Source.
_Avoid_: Bookmark, pin, Collection

**Namespace**:
The grouping a Library Skill belongs to, derived from its Source as `owner/repo`, or `local` when the Source is unknown.
_Avoid_: Category, folder, tag, Collection

**Source**:
Where a Skill came from: a GitHub repo, a skills.sh listing (which resolves to a repo), a Local Source, or local when Dark Matter can't tell.
_Avoid_: Origin, upstream, registry

**Modified**:
A Library Skill from a Source whose contents you have changed since it was last Imported or updated.
_Avoid_: Dirty, forked, customised

**Orphaned**:
A Library Skill whose Source can no longer be reached (repo deleted, renamed or made private, or the Skill's path removed). It is kept as is until you Detach or re-point it.
_Avoid_: Broken, missing, dead

**Detach**:
To cut a Library Skill off from its Source so it becomes a `local` Skill that never receives updates.
_Avoid_: Fork, unlink, eject

**Local Source**:
A folder outside every Agent folder where a Skill is authored (for example your own skills repo). The Library refers to it in place rather than moving it.
_Avoid_: Dev skill, linked source

**Library Lock**:
The single manifest that records every Library Skill's Source, pinned commit and content hash.
_Avoid_: Index, database, metadata file

**Name Conflict**:
Two Library Skills with the same name that are both wanted in the same Agent skill folder, where only one can be Linked.
_Avoid_: Collision, duplicate
