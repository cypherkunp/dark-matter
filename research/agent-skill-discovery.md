# Where each Agent discovers Skills, and whether it follows symlinks

Resolves [#2](https://github.com/cypherkunp/dark-matter/issues/2). Researched 2026-11-19 on macOS (Darwin 27.2). Terms follow [GLOSSARY.md](../GLOSSARY.md): **Agent**, **Skill**, **Project**, **Library**, **Link**, **Adopt**, **Scan**.

Versions checked:

| Agent | Version | How it was checked |
| --- | --- | --- |
| Claude Code | 2.1.329 (installed) | Docs, GitHub issues, and an empirical probe |
| Cursor | IDE 3.30.14, CLI `2026.10.22-27dcf5f` (installed) | Docs, forum threads, and the real `~/.cursor` folders. The CLI probe could not run because the CLI is not logged in |
| OpenCode | v2.2.6 (installed). Source at `anomalyco/opencode@4f98dcb` (2026-11-19, near v2.3.2) | Docs in the repo, source, issues, and an empirical probe |
| Codex CLI | Not installed. Source at `openai/codex@6a8a811` (2026-11-19, near `rust-v0.170.0`) | Docs, source and tests, issues |
| `.agents/skills` convention | agentskills.io guide (read 2026-11-19) | Spec site |

## The short answer

| | Claude Code | Cursor | OpenCode | Codex | `.agents` convention |
| --- | --- | --- | --- | --- | --- |
| **Global folder(s)** | `~/.claude/skills/` | `~/.cursor/skills/`, `~/.agents/skills/`; compat: `~/.claude/skills/`, `~/.codex/skills/` | `~/.config/opencode/skills/`; compat: `~/.claude/skills/`, `~/.agents/skills/` | `~/.agents/skills/`; deprecated: `$CODEX_HOME/skills` (`~/.codex/skills`); admin: `/etc/codex/skills` | `~/.agents/skills/` |
| **Project folder(s)** | `.claude/skills/` in cwd and each parent up to the repo root. Nested `<sub>/.claude/skills/` loads lazily | `.cursor/skills/`, `.agents/skills/`; compat: `.claude/skills/`, `.codex/skills/`. Any such folder anywhere in the repo | `.opencode/skills/`; compat: `.claude/skills/`, `.agents/skills/`, from cwd up to the Project root | `.agents/skills/` in each folder from cwd up to the repo root. Source also scans `.codex/skills/` per trusted Project config layer (undocumented) | `<project>/.agents/skills/` |
| **Precedence on same name** | Enterprise > personal > project. Plugin skills are namespaced (`plugin:skill`) | Not documented | Last registered wins: built-in < `.claude` < `.agents` < global opencode < project `.opencode` < `skills` config entries | No override. Both copies appear | Guide suggests project > user |
| **Plugin / marketplace folders** | `~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/skills/`, `~/.claude/plugins/marketplaces/`, `~/.claude/plugins/synced/`; `~/.claude/skills/synced/` (claude.ai, reserved) | `~/.cursor/plugins/cache/<mkt>/<plugin>/<sha>/skills/`, `~/.cursor/plugins/local/`; built-ins in `~/.cursor/skills-cursor/` (Cursor-managed) | `skills` array in `opencode.json` (paths or HTTP catalogs, cached under `~/.cache/opencode/skills/<hash>/`); plugins can register skills | `$CODEX_HOME/plugins/cache/`; system skills in `~/.codex/skills/.system/` | n/a |
| **Symlinked Skill folder** | **Yes** (documented; probe passed) | **Mostly yes** in current builds, with a history of bugs (see details) | **Yes** (source and probe) | **Yes** for user, repo and admin scopes. Not for the system scope | Not specified |
| **Symlinked `SKILL.md` file** | **Yes** (probe passed) | Unverified | **Yes** (source and probe) | **No.** It is ignored on purpose, as a test asserts | Not specified |
| **Disable one Skill natively** | **Yes.** `skillOverrides: {"<name>": "off"}` in settings. Also a `Skill(name)` deny rule, or `disable-model-invocation: true` in frontmatter | **No full off switch.** `disable-model-invocation: true` limits a Skill to explicit `/name` use | **Yes.** A `skill` permission rule with `"effect": "deny"` for the Skill ID. `metadata.opencode/autoinvoke: false` hides a Skill from the model only | **Yes.** `[[skills.config]]` with `path` or `name` and `enabled = false` in `~/.codex/config.toml`. `agents/openai.yaml` `allow_implicit_invocation: false` hides a Skill from the model only | Guide says clients should hide disabled Skills, but sets no standard key |

### What this means for Dark Matter

1. **Make every Link a directory symlink**, `<agent skills dir>/<skill> -> ~/.dark-matter/.../<skill>`. Never link a lone `SKILL.md`, because Codex ignores symlinked `SKILL.md` files. All four Agents follow directory symlinks in user and Project scopes.
2. **Expect one Link to show up in several Agents.** OpenCode and Cursor also read `~/.claude/skills` and `~/.agents/skills`, and Cursor reads `~/.codex/skills`. So a Link in `~/.agents/skills` reaches Codex, Cursor and OpenCode at once. A Link in `~/.claude/skills` reaches Claude Code, Cursor and OpenCode. The Scan should model "which Agents see this folder", not "which folder belongs to which Agent". This machine already does this: `~/.claude/skills/*` and parts of `~/.cursor/skills/*` are symlinks into `~/.agents/skills/`.
3. **Claude Code is the only Agent that does not read `.agents/skills`.** Feature request [anthropics/claude-code#31005](https://github.com/anthropics/claude-code/issues/31005) is still open as of 2026-11-18. To reach every Agent, Dark Matter needs at least a Link in `~/.agents/skills/` plus a Link in `~/.claude/skills/`.
4. **Disabling a Skill differs per Agent.** Claude Code, OpenCode and Codex have config keys that Dark Matter could write. Cursor has none, so on Cursor the only full off switch is to remove the Link.
5. **Leave Agent-managed folders alone** during Adopt: `~/.cursor/skills-cursor/`, `~/.codex/skills/.system/`, `~/.claude/skills/synced/`, `~/.claude/skills/.trash/`, and the plugin caches. The Agent rewrites them.

## Empirical probe (2026-11-19)

The probe used a throwaway fixture in a temp folder, not a real Agent folder. For each of `.claude`, `.agents`, `.cursor` and `.opencode`, the fixture's `proj/.<x>/skills/` held three Skills:

- `dmtest-<x>-real/`: a real folder.
- `dmtest-<x>-dirlink`: a directory symlink to `lib/dmtest-<x>-dirlink/`.
- `dmtest-<x>-filelink/SKILL.md`: a real folder whose `SKILL.md` is a file symlink to `lib/.../SKILL.md`.

Each Agent was then asked, in non-interactive mode, to list the `dmtest*` Skills in its context.

| Agent | Skills it listed | Takeaway |
| --- | --- | --- |
| Claude Code 2.1.329 (`claude -p`) | `dmtest-claude-{real,dirlink,filelink}` | Follows both symlink kinds. Does not read `.agents/`, `.cursor/` or `.opencode/` |
| OpenCode 2.2.6 (`opencode run`) | `dmtest-{agents,claude,opencode}-{real,dirlink,filelink}` | Follows both symlink kinds. Reads `.claude/` and `.agents/`. Does not read `.cursor/` |
| Cursor CLI 2026.10.22 | Not run (`Authentication required`) | **Open:** re-run after `agent login`, and check the Cursor IDE by hand |
| Codex | Not installed | Relies on source and tests (below) |

Caveat: both agents answered from the Skill list in their context, as reported by a model. No tool reported it. The results line up with the source code, but they are model output, not a structured listing.

## Details per Agent

### Claude Code

**Folders.** These come from the [Skills docs](https://code.claude.com/docs/en/skills), read 2026-11-19:

- Enterprise: `.claude/skills/` inside the managed settings folder.
- Personal: `~/.claude/skills/<name>/SKILL.md`.
- Project: `.claude/skills/` in the start folder and every parent up to the repo root.
- Nested: `<subdir>/.claude/skills/` loads "the first time Claude reads or edits a file in that subdirectory".
- `--add-dir <dir>`: loads `<dir>/.claude/skills/`. Same-name Skills there get a prefix, such as `/cli:verify`.
- Plugins: `<plugin>/skills/<name>/SKILL.md`, namespaced `/plugin:skill`.
- Skills from the claude.ai account are synced into `~/.claude/skills/synced/`. The name `synced` is reserved.
- **Not** `.agents/skills`. See [#31005](https://github.com/anthropics/claude-code/issues/31005) (open), [#66352](https://github.com/anthropics/claude-code/issues/66352) (closed as not planned, 2026-07-16) and [#16345](https://github.com/anthropics/claude-code/issues/16345) (closed as a duplicate, 2026-10-22).

**Precedence.** Enterprise beats personal, and personal beats project. A Skill beats a `.claude/commands/` file with the same name. Root and nested project Skills with the same name both load. Plugin Skills never collide because they are namespaced.

**Plugin folders.** These come from the [plugin loading reference](https://code.claude.com/docs/en/plugins/loading.md):

- Root: `~/.claude/plugins/`, or `CLAUDE_CODE_PLUGIN_CACHE_DIR` if set.
- `cache/<marketplace>/<plugin>/<version>/` holds copied installs.
- `marketplaces/<name>/` holds marketplace clones.
- `synced/` and `.trash/` hold claude.ai plugins.
- `installed_plugins.json` and `known_marketplaces.json` record installs. Both exist on this machine.
- A folder with `.claude-plugin/plugin.json` under `~/.claude/skills/` or `.claude/skills/` loads as a `@skills-dir` plugin, in place.

**Symlinks.**

- Skill folders: **yes.** The docs say: "a `<skill-name>` entry in the enterprise, personal, or project location can be a symlink to a directory elsewhere on disk. Claude Code reads `SKILL.md` from the target and loads the skill once even if several locations point at the same target. Plugin skills handle symlinks differently."
- A symlinked `SKILL.md` file: **yes** (probe).
- Plugin components may not resolve outside the plugin root, and a symlink that leads outside is rejected with `path escapes plugin directory` ([loading reference](https://code.claude.com/docs/en/plugins/loading.md#paths-that-escape-the-plugin-directory)). Links into plugin folders will therefore not work.
- Known rough edges:
  - [#109687](https://github.com/anthropics/claude-code/issues/109687), open, v2.1.322: if `~/.claude/skills` *itself* is a symlink into the Project, Skills load twice after a file under the target is touched. **Link each Skill, not the whole `skills` folder.**
  - [#72631](https://github.com/anthropics/claude-code/issues/72631): the VS Code `/` palette did not index new symlinked Skills until a reload. Closed as not planned, 2026-09-06.

**Live reload.** Claude Code watches `~/.claude/skills`, the Project's `.claude/skills` and `--add-dir` skill folders. A new top-level skills folder needs `/reload-skills`.

**Disable one Skill.**

- `skillOverrides` in settings: `"on"`, `"name-only"`, `"user-invocable-only"` or `"off"`. `"off"` hides the Skill from Claude and from the `/` menu. It does not cover plugin Skills; manage those with `enabledPlugins` or `/plugin`.
- Permission rules: `Skill(name)` or `Skill(name *)` in deny rules.
- Frontmatter: `disable-model-invocation: true` (only the user can invoke it) and `user-invocable: false`.
- `disableBundledSkills: true` turns off all bundled Skills.

### Cursor

**Folders.** These come from the [Cursor Skills docs](https://cursor.com/docs/context/skills), read 2026-11-19:

- Project: `.agents/skills/` and `.cursor/skills/`.
- User: `~/.agents/skills/` and `~/.cursor/skills/`.
- Compatibility: `.claude/skills/`, `.codex/skills/`, `~/.claude/skills/` and `~/.codex/skills/`.
- "Cursor walks the skills root recursively and picks up any `SKILL.md` it finds". A `.cursor/skills/` or `.agents/skills/` folder anywhere inside the repo is picked up.
- **Precedence: not documented.** Flagged as uncertain.

**Built-in and plugin folders.** These were seen on this machine and are not in the docs:

- `~/.cursor/skills-cursor/` holds Cursor-managed built-ins. Its `.cursor-managed-skills-manifest.json` has `builtinSkillIds` and `managedSkillIds`, and `.sync-manifest.json` has sync timestamps. Do not touch it.
- `~/.cursor/plugins/cache/<marketplace>/<plugin>/<sha>/skills/<name>/SKILL.md`, for example `cursor-public/context7/...`.
- `~/.cursor/plugins/local/`.
- Plugins come from marketplaces that use `.cursor-plugin/marketplace.json`, per the docs.

**Symlinks: uncertain but mostly yes in current builds.**

- [Forum 150028](https://forum.cursor.com/t/global-symlinked-skills-are-not-discovered-by-cursor/150028): on Cursor 2.4.21 (2026-01-27), symlinks in `~/.cursor/skills` were not discovered. Staff called it a known issue and said on 2026-02-10 that it "will be fixed in 2.5".
- [Forum 149693](https://forum.cursor.com/t/cursor-doesnt-follow-symlinks-to-discover-skills/149693): staff said the bug "also affects Rules". Last active 2026-02-24.
- [Forum 163569](https://forum.cursor.com/t/discovery-of-symlinked-skills-not-working-for-all-cases-in-cli/163569) (2026-06-18): a user said CLI `2026.06.15` missed some targets. Staff could not reproduce on the latest CLI and said "Discovery finds all 8 skills no matter where the symlink target lives." The IDE found all eight.
- [Forum 168425](https://forum.cursor.com/t/cannot-open-symlinked-global-skill-rule-in-editor/168425) (2026-08-14, v3.15.19): symlinked global Skills appear in Customize, but over Remote-SSH they fail to open. That is a separate bug.
- "Symlink support for skills missing in Cursor Cloud Agent" (forum, 2026-09-08) and an SDK local-runtime thread ([160664](https://forum.cursor.com/t/cursor-sdk-local-runtime-does-not-appear-to-load-filesystem-skills/160664)) report that symlinks are dropped outside the desktop app.
- On this machine, `~/.cursor/skills/{computer-use,orca-cli,orchestration}` are directory symlinks into `~/.agents/skills/`, but loading was not confirmed.
- Symlinked `SKILL.md` files: no evidence either way.
- **Action:** run the probe in the Cursor IDE 3.30 and in a logged-in CLI before relying on Links for Cursor. Plan to copy instead of linking for Cursor Cloud Agents.

**Disable one Skill.** There is no documented setting. `disable-model-invocation: true` in frontmatter makes a Skill "only included when explicitly invoked via `/skill-name`". It does not turn the Skill off, and it means editing the Skill. Dark Matter's full off switch for Cursor is to remove the Link.

### OpenCode

**Folders.** These come from the v2 docs ([`services/site/src/docs/content/skills.mdx@4f98dcb`](https://github.com/anomalyco/opencode/blob/4f98dcbcbf528b9f086e7aedbf28f7aa11b40488/services/site/src/docs/content/skills.mdx)). The v1 docs list the same six locations ([`docs/v1/content/skills.mdx`](https://github.com/anomalyco/opencode/blob/4f98dcbcbf528b9f086e7aedbf28f7aa11b40488/services/site/src/docs/v1/content/skills.mdx)).

- Global: `~/.config/opencode/skills`.
- Global compatibility: `~/.claude/skills` and `~/.agents/skills`.
- Project: `.opencode/skills`.
- Project compatibility: `.claude/skills` and `.agents/skills`.
- Project sources are searched "from the current directory up to the project root", at every level.
- A source can hold `<name>/SKILL.md`, nested `group/<name>/SKILL.md`, or root-level `<name>.md` files.
- Discovery skips hidden entries and `node_modules`, and stops 6 levels deep.
- **The Skill ID comes from the folder name, not from frontmatter `name`.**
- Extra sources come from the `skills` array in any `opencode.json(c)`: paths, or `https://` catalogs with an `index.json`. Catalogs are cached under the global cache, `~/.cache/opencode/skills/<hash>/`.

**Precedence.** These are registered low to high, and the last one wins:

1. Built-in.
2. `.claude/skills`, global first, then from the farthest ancestor toward the cwd.
3. `.agents/skills`, in the same order.
4. `~/.config/opencode/skills`.
5. The Project's `.opencode/skills`.
6. `skills` config entries.

**Symlinks: yes, both kinds.**

- [`skill-scan.ts@4f98dcb`](https://github.com/anomalyco/opencode/blob/4f98dcbcbf528b9f086e7aedbf28f7aa11b40488/packages/core/src/config/plugin/skill-scan.ts) calls `stat()` on every `SymbolicLink` entry. A link to a folder is walked, and a link to a file named `SKILL.md` counts as the Skill. The probe confirmed both on v2.2.6.
- History:
  - [#42216](https://github.com/anomalyco/opencode/issues/42216): cyclic symlinks in global Skills caused unbounded memory use. Closed 2026-10-11.
  - [#27638](https://github.com/anomalyco/opencode/issues/27638): circular symlinks caused an `ENAMETOOLONG` crash. Closed 2026-07-14.
  - [#27027](https://github.com/anomalyco/opencode/issues/27027): following symlinks into large trees made startup slow. Closed 2026-07-12.
  - [#17219](https://github.com/anomalyco/opencode/issues/17219): symlinked folders were not deduplicated. Closed 2026-07-03.
  - [#18848](https://github.com/anomalyco/opencode/issues/18848): `.claude/skills` as a symlink in a worktree sandbox. Closed 2026-08-12.
- **Keep Library targets small and acyclic.**

**Disable one Skill.**

- Permission rules in `opencode.jsonc`, globally or under `agents.<id>.permissions`:

  ```jsonc
  { "permissions": [{ "action": "skill", "resource": "<id>", "effect": "deny" }] }
  ```

  `deny` hides the Skill from the model and refuses to load it. The last matching rule wins. v1 used `"permission": { "skill": { "<id>": "deny" } }`.
- Frontmatter `metadata.opencode/autoinvoke: false` or `disable-model-invocation: true` only hides the Skill from the model's list. It can still be loaded by ID.

### Codex CLI

**Folders.** These come from the docs, [developers.openai.com/codex/skills](https://developers.openai.com/codex/skills), which now redirects to [learn.chatgpt.com/docs/build-skills](https://learn.chatgpt.com/docs/build-skills) (read 2026-11-19), and from source ([`host_roots.rs@6a8a811`](https://github.com/openai/codex/blob/6a8a81166aa243fe210382dfe988d94a70a4bef2/codex-rs/ext/skills/src/host_roots.rs) and [`capability_locations.rs@6a8a811`](https://github.com/openai/codex/blob/6a8a81166aa243fe210382dfe988d94a70a4bef2/codex-rs/exec-server/src/discoverV2/capability_locations.rs)):

- REPO: `.agents/skills` in each folder from the cwd up to the repo or Project root.
- USER: `$HOME/.agents/skills`, plus `$CODEX_HOME/skills` (`~/.codex/skills`). The source comments mark the second one as "Deprecated user skills location … kept for backward compatibility".
- ADMIN: `/etc/codex/skills`.
- SYSTEM: bundled Skills cached under `$CODEX_HOME/skills/.system/`. This machine has `skill-creator` and `skill-installer` there.
- The source also adds `<project>/.codex/skills` for each Project config layer (`ConfigLayerSource::Project`, scope Repo). This is **undocumented**, so flag it as uncertain.
- Plugins: `$CODEX_HOME/plugins/cache` (`PLUGINS_CACHE_DIR = "plugins/cache"`).
- Codex is not installed here, so none of these paths were checked on disk.

**Precedence.** The docs say: "If two skills share the same `name`, Codex doesn't merge them; both can appear in skill selectors." Roots are only deduplicated by path.

**Symlinks.**

- Skill folders: **yes** for USER, REPO and ADMIN, and **no** for SYSTEM. In [`loader/host.rs@6a8a811`](https://github.com/openai/codex/blob/6a8a81166aa243fe210382dfe988d94a70a4bef2/codex-rs/ext/skills/src/loader/host.rs), `SkillScope::User | Repo | Admin => DirectorySymlinkPolicy::Follow` and `SkillScope::System => Ignore`. The docs agree: "Codex supports symlinked skill folders and follows the symlink target when scanning these locations."
- A symlinked `SKILL.md` file: **no.** The test `ignores_symlinked_skill_files_and_directory_cycles` in [`loader/discovery_tests.rs`](https://github.com/openai/codex/blob/6a8a81166aa243fe210382dfe988d94a70a4bef2/codex-rs/ext/skills/src/loader/discovery_tests.rs) (last changed 2026-09-17) asserts that a `linked-file/SKILL.md` symlink is *not* discovered. Matching issues:
  - [#15756](https://github.com/openai/codex/issues/15756): "Symlinked SKILL.md files are not discovered … (only symlinked directories are followed)". Closed as not planned, 2026-03-25.
  - [#10470](https://github.com/openai/codex/issues/10470): closed as not planned.
  - [#10976](https://github.com/openai/codex/issues/10976): closed as a duplicate.
  - [#11332](https://github.com/openai/codex/issues/11332), the stow/dotfiles report, was closed as "completed" on 2026-02-10. Current source contradicts that, so the source is taken as authoritative.
- Open: [#30795](https://github.com/openai/codex/issues/30795), "Skill watcher follows directory symlinks and can recurse into huge external trees". Keep Link targets small.

**Disable one Skill.** Add this to `~/.codex/config.toml` and restart Codex:

```toml
[[skills.config]]
path = "/abs/path/to/skill/SKILL.md"   # or: name = "skill-name"
enabled = false
```

- Each entry takes exactly one selector, and the last matching entry wins. The schema is `SkillConfig { path, name, enabled }` in [`config/src/skills_config.rs`](https://github.com/openai/codex/blob/6a8a81166aa243fe210382dfe988d94a70a4bef2/codex-rs/config/src/skills_config.rs).
- `[skills.bundled] enabled = false` turns off the system Skills. It can go in a trusted Project's `.codex/config.toml`.
- `agents/openai.yaml` with `policy: allow_implicit_invocation: false` only stops implicit use. Codex will not pick the Skill from prompts, but `$skill` still works.

### The generic `.agents/skills` convention

The [agentskills.io client guide](https://agentskills.io/client-implementation/adding-skills-support) (read 2026-11-19) recommends scanning `<project>/.agents/skills/` and `~/.agents/skills/` next to the client's own folder. It also mentions `.claude/skills`, ancestor folders up to the git root, XDG folders, and user-set paths as common extras.

- On a name collision, "project-level skills override user-level skills". Within one scope, the client can pick first-found or last-found but must be consistent.
- It recommends a scan depth of 4 to 6 and gating project Skills on trust.
- On disabling, it says clients should hide Skills "the user has disabled … in settings" from the catalog, but it defines no shared key.
- **It says nothing about symlinks.** The spec only defines what goes *inside* a Skill folder.

Who reads `.agents/skills` today:

- Read it: Cursor, OpenCode and Codex.
- Does not read it: Claude Code.

## Open questions and uncertainties

1. **Cursor symlink behaviour in 3.30 and the current CLI has not been tested.** The evidence is forum threads from 2026-01 to 2026-09. Run the fixture probe in the IDE and in a logged-in `agent` CLI.
2. **Cursor precedence** for duplicate names across `.cursor`, `.agents`, `.claude` and `.codex` is not documented.
3. **Codex `<project>/.codex/skills`** appears in the source but not in the docs. It may be a legacy path and may go away.
4. **Codex runtime behaviour was not tested** because Codex is not installed. Findings rest on `main@6a8a811` and may differ slightly from the `rust-v0.170.0` release.
5. **OpenCode v1 and v2 differ:** v1.19.6 is still tagged "Latest", while v2.x ships in parallel. The folders match, but the permission config shape differs (`permission.skill` map vs. `permissions` array). Dark Matter must detect which version it is talking to before writing config.
6. Whether **Claude Code, OpenCode and Cursor follow symlinked *supporting* files** such as `scripts/x.sh` inside a Skill was not probed. Those files are read on demand by the model's file tools, which normally follow symlinks. Codex's walk leaves file symlinks out of its inventory, but the model can still read them.
