# Agents control Dark Matter through one consent-gated surface, and consent is a guardrail, not a security boundary

Agents (over a stdio MCP shim) and humans or Agents in a shell (the `dm` CLI) reach the core (ADR-0003) through **one operation surface with one consent policy, both enforced in the core**. Consent exists to make Agent actions visible and to stop accidental changes. It does **not** defend against a hostile Agent. Any Agent with a shell can already run `ln -s` or edit `.mcp.json`, and a user-level app can't prevent that. We chose this for two reasons. A CLI that skipped consent would let an Agent bypass the guardrail just by running `dm`. And treating consent as a real security boundary would pull in auth machinery that can't keep its promise.

## The surface

- **Reads are free** and need no consent: the Library, any Project's Project Skills and Project MCP Servers, Scan results, the Inbox and the Activity Log. Secret values are never returned through any client except the app, only their names.
- **Mutations an Agent can request:** add or remove a Project Skill (Link or Copy), turn a Project Skill or Project MCP Server On or Off, add or remove a Project MCP Server (Personal or Shared), and Import from GitHub (it only adds, never overwrites).
- **App-only:** Adopt, Detach, deleting a Library Skill, editing Skill contents, resolving updates on a Modified Skill, entering or reading Secrets, settings, Favourites, and confirming Suggested Projects. These move, delete or rewrite owned content, or touch Secrets.
- **Scope:** an MCP shim can write only to the Project baked into its entry. The CLI defaults to the cwd Project, accepts `--project`, and still needs consent for whichever Project it targets.

## Consent

- Every mutation is a **Request**. The core first returns the plan, so a dry run comes for free.
- A per-Project **Grant** (off by default, revocable, stored in `projects.json`) lets low-risk Requests through without asking: On/Off, and adding or removing a Link. A Copy (a committed team change), a Shared MCP Server, any new Project MCP Server (it runs code) and an Import (it fetches from the network) **always ask**.
- **App running (tray or window):** a native notification with Approve and Deny, plus an Inbox item. The call waits about 60 seconds and then returns `pending`.
- **Only a headless core is running:** the Request goes into the Inbox for the next time the app opens, and the Agent is told it's pending. The shim never launches the app.
- Pending Requests are owned state in `requests.json` (ADR-0005). They expire after 24 hours and are re-validated against the current state before they're applied.
- Every Request and its outcome goes to the Activity Log under the requesting client. For MCP, that includes the Agent's name.

## Delivering the shim

The shim reaches a Project only as an ordinary, opt-in Project MCP Server called **dark-matter**. It's always Personal and never global (ADR-0002), and you add it with "Let Agents control this Project". Dark Matter writes it separately for each Agent as `dm mcp --agent <agent> --project <absolute path>`. The shim trusts that baked-in path, not the cwd or MCP `roots`, because Agents disagree on both: Cursor reportedly launches servers in their own directory, and Codex doesn't declare `roots`. If the path in the entry isn't a confirmed Project any more, the shim is read-only. The entry is never committed, so an absolute path is harmless.

## Status

Designed now so the v1 core carries client identity, the per-operation policy check, Requests and Activity attribution from the start. The `cli` package (the CLI and the MCP shim) ships after v1, as its first milestone.

## Considered Options

- **CLI is trusted and skips consent:** rejected. An Agent would simply use the CLI instead of MCP.
- **Ask every time, with no Grants:** rejected. Toggling or Linking a Skill in your own Project would stay tedious.
- **A Grant covers everything:** rejected. A committed Copy, a Shared MCP Server or a new MCP Server affects teammates or runs code, so it deserves a human look every time.
- **Resolve the Project from cwd or `roots`:** rejected. Behaviour differs between Agents.
- **Dark Matter auto-adds itself to every Project:** rejected. Agent control is opt-in for each Project.
