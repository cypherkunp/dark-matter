# MCP Server config locations, formats and toggles per Agent

Resolves [#3](https://github.com/cypherkunp/dark-matter/issues/3). Researched 2026-11-19.

Versions checked:

| Agent | Version used as reference | Docs fetched |
| --- | --- | --- |
| Claude Code | 2.1.329 installed locally; latest release v2.1.328 (2026-11-19) | 2026-11-19 |
| Cursor | 3.30.14 installed locally (editor), plus Cursor CLI `agent` | 2026-11-19 |
| OpenCode | v2.2.6 installed locally; latest v2.3.2 (2026-11-18); V1 line still ships (v1.19.6, 2026-11-17) | 2026-11-19 |
| Codex CLI | not installed locally; source read at `openai/codex@6a8a81166a`, latest release `rust-v0.170.0` (2026-11-18) | 2026-11-19 |
| `.agents` | no spec for MCP exists (see below) | 2026-11-19 |

Local files on this machine were read only to confirm paths and shapes. Secret values were redacted and are not reproduced here.

Confidence markers: **[doc]** official docs, **[src]** read in the Agent's source, **[local]** seen on this machine, **[forum]** community or staff forum post, **[uncertain]** inferred or unconfirmed.

## Summary

- Every Agent keys its MCP Servers by name in a map. The maps live under different keys, use different field names, and two of the four use different interpolation syntaxes. Dark Matter needs one adapter per Agent to translate between them.
- Only **Codex** and **OpenCode** have a native per-server enabled/disabled flag inside the config file. **Claude Code** keeps toggles in separate lists (`~/.claude.json` and settings files). **Cursor** keeps them in its SQLite state DB, outside any file Dark Matter should edit.
- Precedence differs too. Claude Code and OpenCode V2 replace the whole entry for a given name. Codex deep-merges TOML tables field by field. For Cursor, the precedence between global and project entries isn't documented.
- Claude Code's `~/.claude.json` is the riskiest file to write. It's a large state file the CLI rewrites all the time, and it has a history of race-condition corruption.

## Comparison table

| | Claude Code | Cursor | OpenCode (V2) | Codex CLI |
| --- | --- | --- | --- | --- |
| **Global (user)** | `~/.claude.json` → top-level `mcpServers` ("user" scope) | `~/.cursor/mcp.json` | `~/.config/opencode/opencode.json` or `.jsonc` | `~/.codex/config.toml` (`$CODEX_HOME/config.toml`) |
| **Per Project, shared (committed)** | `<project>/.mcp.json` ("project" scope) | `<project>/.cursor/mcp.json` | `<project>/opencode.json[c]` or `<project>/.opencode/opencode.json[c]`; parent dirs are walked | `<project>/.codex/config.toml`, plus `.codex/config.toml` in parent dirs up to the repo root. **Trusted projects only** |
| **Per Project, private (local)** | `~/.claude.json` → `projects["<abs path>"].mcpServers` ("local" scope, the default for `claude mcp add`) | none | none | none (a per-project trust entry lives in the user config) |
| **Managed / system** | `managed-mcp.json` at `/Library/Application Support/ClaudeCode/` (macOS), `/etc/claude-code/` (Linux), `C:\Program Files\ClaudeCode\` (Windows); `managedMcpServers` in managed settings | Team/enterprise dashboard (not a local file) **[uncertain]** | `/Library/Application Support/opencode` (macOS), `/etc/opencode`, `%ProgramData%\opencode`; MDM plist `ai.opencode.managed.plist` | `/etc/codex/config.toml` (`%ProgramData%\OpenAI\Codex\config.toml`); `requirements.toml` and MDM for constraints |
| **Format** | Strict JSON | JSON | JSON or JSONC (comments, trailing commas) | TOML |
| **Root key** | `mcpServers.<name>` | `mcpServers.<name>` | `mcp.servers.<name>` (V1: `mcp.<name>`) | `[mcp_servers.<name>]` |
| **stdio fields** | `type:"stdio"` (optional), `command`, `args[]`, `env{}` | `type` (optional), `command`, `args[]`, `env{}`, `envFile` | `type:"local"`, `command[]` (one array holding the program and its args), `environment{}`, `cwd` | `command`, `args[]`, `env{}`, `env_vars[]`, `cwd` |
| **Remote fields** | `type:"http"`/`"sse"`/`"ws"`, `url`, `headers{}`, `headersHelper`, `oauth{}` | `url`, `headers{}`, `auth{}` | `type:"remote"`, `url`, `headers{}`, `oauth{}` or `false` | `url`, `bearer_token_env_var`, `http_headers{}`, `env_http_headers{}`, `http_headers_helper`, `auth`, `oauth.*` |
| **Interpolation** | `${VAR}`, `${VAR:-default}` | `${env:VAR}`, `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${/}` | `{env:VAR}`, `{file:path}` | none in values; reference env by name instead (`env_vars`, `bearer_token_env_var`, `env_http_headers`) |
| **Precedence (high → low)** | managed > local > project > user > plugin > claude.ai connectors | not documented; local evidence suggests both entries are kept side by side (see details) **[uncertain]** | managed/MDM > system > `.opencode/` files > direct project files (closest dir wins) > global | managed/MDM > `--config` flags > project (closest wins) > profile > user > cloud > system |
| **Merge on name clash** | whole entry replaced, no field merge **[doc]** | **[uncertain]** | whole entry replaced (`Map.set`) **[src]** | deep table merge, field by field; arrays replace **[src]** |
| **Native per-server toggle in the config file** | **No** | **No** | **Yes**: `"disabled": true` (V1: `"enabled": false`) | **Yes**: `enabled = false` |
| **Where UI toggles are stored** | `~/.claude.json` → `projects[path].disabledMcpServers` / `enabledMcpServers`; `.mcp.json` approval in `enabledMcpjsonServers` / `disabledMcpjsonServers` / `enableAllProjectMcpServers` (settings files) | SQLite `state.vscdb`: `cursor/disabledGlobalMcpServers` (global DB) and `cursor/disabledMcpServers` (per-workspace DB); CLI: `~/.cursor/projects/<slug>/mcp-approvals.json` | the same config file | the same config file |
| **Per-tool filter** | permissions (`mcp__server__tool`) | UI only (state DB) | `permissions` rules (`<server>_<tool>`) | `enabled_tools`, `disabled_tools`, `tools.<t>.approval_mode` |
| **OAuth token storage** | OS keychain | `state.vscdb` `secret://` entries + `~/.cursor/projects/<slug>/mcp-auth.json` **[local]** | Agent data dir **[uncertain]** | keyring or file (`mcp_oauth_credentials_store`) |
| **How the Agent writes the file** | Read-modify-write of a large JSON state file; many writes per session | Editor UI writes `mcp.json`; toggles go to the DB | `jsonc-parser` `modify` + `applyEdits` (keeps comments) | `toml_edit` (keeps comments and layout) + atomic write; resolves symlinks |

## Claude Code

Sources: [MCP docs](https://code.claude.com/docs/en/mcp), [Managed MCP](https://code.claude.com/docs/en/managed-mcp), fetched 2026-11-19 (pages are undated; they mention behavior up to v2.1.305). Local: Claude Code 2.1.329.

### Locations and scopes

| Scope | Stored in | Shared |
| --- | --- | --- |
| Local (default for `claude mcp add`) | `~/.claude.json`, under `projects["/abs/path"].mcpServers` | no |
| Project | `.mcp.json` at the project root | yes, through VCS |
| User | `~/.claude.json`, top-level `mcpServers` | no |
| Managed | `managed-mcp.json` (system path, see table) and `managedMcpServers` in managed settings | org-wide |

Plugins can also contribute servers, and so can claude.ai connectors. Dark Matter should Scan both (see "Out-of-file sources" below) but not edit them.

**[local]** On this machine, `~/.claude.json` is about 166 KB and has about 60 unrelated top-level keys (onboarding, caches, feature flags, `oauthAccount`, and more). Its `projects` map holds per-Project `mcpServers` and `disabledMcpServers`, for example `"disabledMcpServers": ["claude-in-chrome", "plugin:figma:figma"]`. Plugin servers are identified as `plugin:<plugin>:<server>`.

**[uncertain]** `CLAUDE_CONFIG_DIR` moves `~/.claude`. The docs don't say whether it also relocates `~/.claude.json`. Dark Matter should honor the variable and check both locations.

### Schema

```json
{
  "mcpServers": {
    "local-tool": { "type": "stdio", "command": "npx", "args": ["-y", "@example/mcp"], "env": { "API_KEY": "${API_KEY}" } },
    "api": { "type": "http", "url": "${API_BASE_URL:-https://api.example.com}/mcp", "headers": { "Authorization": "Bearer ${API_KEY}" } }
  }
}
```

- `type` is `stdio` (assumed when omitted), `http` (alias `streamable-http`), `sse` (deprecated), `ws`, or `sdk`. `sdk` entries are skipped in files. An entry with a `url` but no `type` is an error and is skipped.
- Optional fields: `timeout` (ms), `alwaysLoad`, `oauth{clientId, callbackPort, authServerMetadataUrl, scopes}`, `headersHelper` (a shell command that prints headers).

### Precedence and merge

Local > project > user > plugin > claude.ai connectors. `managedMcpServers` ranks above all of them, and `managed-mcp.json` takes exclusive control. The three scopes match by name. The winning source supplies the **entire entry**, and fields are not merged. Plugins and connectors de-duplicate by endpoint URL. **[doc]**

### Toggles (no in-file flag)

- **`/mcp` toggle**: writes to `~/.claude.json` per project. `disabledMcpServers` is an opt-out list for user, plugin, managed, connector and default-on built-in servers. `enabledMcpServers` is an opt-in list for default-off built-ins such as `computer-use`.
- **`.mcp.json` approval**: `enableAllProjectMcpServers`, `enabledMcpjsonServers` and `disabledMcpjsonServers` in settings files (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed). In an untrusted folder, approvals from the project's own `.claude/settings.json` are ignored. `disabledMcpjsonServers` in any settings file rejects a server.
- **Policy**: `allowedMcpServers` and `deniedMcpServers` (matched by `serverName`, `serverCommand` or `serverUrl`).
- **[uncertain]** The docs don't say which list `/mcp` writes when you toggle a `.mcp.json` server. Verify this empirically before building on it.

The cleanest way for Dark Matter to toggle an MCP Server is to add its name to the right list for that Project. It shouldn't move entries between files.

### Env and secrets

Secrets are usually written inline in `env` or `headers`, or as `${VAR}` references. Since v2.1.219, credential-like variables (`ANTHROPIC_API_KEY`, `NPM_TOKEN`, and others) read as empty inside a remote server's `url` and `headers`. Unset variables with no default load as the literal `${VAR}` text and produce a warning. OAuth tokens live in the OS keychain, and `claude mcp remove` deletes them. `managed-mcp.json` can be read by every user on the machine, so the docs advise against storing credentials there.

### Write risks

- **`~/.claude.json` is a hot state file.** Claude Code rewrites it often (tool usage, tips, caches). There's a long history of read-modify-write races that corrupted or truncated it: [#1035](https://github.com/anthropics/claude-code/issues/1035) (opened 2025-05, closed 2026-01-04), plus a cluster of reports around v2.1.59 in 2026-02 such as [#29395](https://github.com/anthropics/claude-code/issues/29395) ("unsynchronized read-modify-write", closed 2026-03-03). **[uncertain]** Whether current versions use atomic writes or a file lock isn't documented.
- **Mitigation for Dark Matter:** prefer `claude mcp add/remove` where it covers the change. Otherwise re-read immediately before writing, change only the target keys, write to a temp file and rename it, and check whether `claude` processes are running. Never round-trip the whole file through a typed model, because unknown keys must survive.
- `.mcp.json` is strict JSON, with no comments shown in any example. It's committed, so writes show up in the user's git diff.

## Cursor

Sources: [Cursor MCP docs](https://cursor.com/docs/context/mcp), [Cursor CLI MCP](https://cursor.com/docs/cli/mcp), fetched 2026-11-19 (undated). Cursor is closed source. Local: Cursor 3.30.14.

### Locations

- Global: `~/.cursor/mcp.json`
- Project: `<project>/.cursor/mcp.json`
- The CLI (`agent`) uses the same files and "discovers configurations from parent directories automatically" (project, then global, then nested). **[doc]**, but the wording is vague.

### Schema

```json
{
  "mcpServers": {
    "local": { "command": "npx", "args": ["-y", "pkg"], "env": { "TOKEN": "${env:TOKEN}" }, "envFile": "${workspaceFolder}/.env" },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${env:TOKEN}" } }
  }
}
```

- Fields: `type`, `command`, `args`, `env`, `envFile` (stdio only), `url`, `headers`, `auth{CLIENT_ID, CLIENT_SECRET, scopes}`.
- Interpolation works in `command`, `args`, `env`, `url`, `headers` and `auth`: `${env:NAME}`, `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}` / `${/}`.
- **[local]** In practice Cursor also accepts a whole command line in one string (`"command": "npx @playwright/mcp@latest"`) without `args`. Dark Matter's parser must tolerate this.

### Precedence and merge — [uncertain]

The official docs don't define what happens when the global and project files declare the same name. Third-party guides claim the project entry overrides the global one, for example [morphllm guide](https://www.morphllm.com/cursor-mcp-server). **[local]** evidence points the other way: Cursor's `mcpService.knownServerIds` lists `user-playwright` alongside `project-0-portfolio-playwright`. IDs carry a scope prefix, so both entries appear to load side by side. A [forum thread](https://forum.cursor.com/t/mcp-servers-appear-duplicated-when-workspace-root-is-the-users-home-directory/158320) also reports duplicates when the workspace root is `~`. Treat these as separate servers until this is tested.

### Toggles (no in-file flag)

- **Editor**: toggled in the Customize / MCP UI. **[local]** The state lives in SQLite at `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`, key `cursor/disabledGlobalMcpServers` (JSON array of IDs such as `["user-vercel"]`). Each workspace also has `workspaceStorage/<hash>/state.vscdb`, key `cursor/disabledMcpServers`. Cursor staff confirmed the state is per workspace in the DB ([forum, 2025-11-05, Cursor 2.0.43](https://forum.cursor.com/t/disabled-mcp-servers-become-enabled-after-each-restart/141009)). Servers in a window with no folder open start enabled.
- **CLI**: `agent mcp enable|disable <id>`. **[local]** The approvals are stored at `~/.cursor/projects/<path-slug>/mcp-approvals.json` as an array of `"<name>-<16 hex>"`. The hash is probably derived from the server config. **[uncertain]**
- A `disabledServers` key inside `mcp.json` is reported as ignored ([forum](https://forum.cursor.com/t/cursor-mcp-server-toggle-bug-report/129256)). Cursor has no supported in-file flag.
- **Implication:** Dark Matter can Scan the toggle state by reading `state.vscdb` read-only. Writing to it while Cursor runs is unsafe: the DB is about 1.5 GB here, and the schema is private and changes between versions. The safe ways to disable a server are either (a) remove it from `mcp.json` and keep a copy in Dark Matter, or (b) show "toggle in Cursor" as a manual step. This needs an ADR.

### Env and secrets

Secrets are often written inline. **[local]** The global `mcp.json` here holds a plaintext `Authorization` header and an API-key header. The recommended pattern is `${env:VAR}` or `envFile`. OAuth client info and tokens live in `state.vscdb` (`secret://…anysphere.cursor-mcp…`, `mcpOAuth.*` keys) and in per-project `mcp-auth.json`.

### Write risks

- Plain JSON. No documented support for comments. Cursor rewrites the file when you add servers through its UI.
- Forum reports describe flaky hot reload of `mcp.json` edits ([regression thread](https://forum.cursor.com/t/mcp-server-regression-does-not-reload-tools-disconnect-does-nothing-ignores-mcp-json-changes-etc/166216)). After an external write, the user may need to restart Cursor or reload the server.
- `mcp.json` files are `0600` here. Preserve file mode when writing.

## OpenCode

Sources: [MCP servers](https://opencode.ai/docs/mcp-servers/), [Config](https://opencode.ai/docs/config/), and in source `anomalyco/opencode@4f98dcbcbf` (branch `dev`): `packages/schema/src/config/mcp.ts`, `packages/core/src/config/plugin/mcp.ts`, `packages/core/src/config/discovery.ts`, `packages/core/src/v1/config/migrate.ts`, `packages/cli/src/commands/handlers/mcp/add.ts`, `services/site/src/docs/content/migrate-v1.mdx`. Fetched 2026-11-19. Local: v2.2.6.

### Locations

- Global: `~/.config/opencode/opencode.json` or `opencode.jsonc` (**[local]**: `opencode.jsonc` exists).
- Project: `opencode.json[c]` in any directory from cwd up to the filesystem root, plus `.opencode/opencode.json[c]` in those directories.
- System: `/Library/Application Support/opencode`, `/etc/opencode`, `%ProgramData%\opencode`. MDM: `ai.opencode.managed.plist`.
- `opencode mcp add` writes to the project file by default and to the global file with `--global`.
- OpenCode V2 also reads `~/.claude`, `~/.agents`, `.claude/` and `.agents/`, but **only for `skills/`**, not for MCP (`config/plugin/compatibility.ts`). **[src]**

### Schema (V2 native)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "timeout": { "startup": 30000 },
    "servers": {
      "playwright": { "type": "local", "command": ["npx", "@playwright/mcp"], "environment": { "TOKEN": "{env:TOKEN}" }, "disabled": false },
      "remote": { "type": "remote", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer {env:TOKEN}" }, "oauth": false }
    }
  }
}
```

- Local fields: `type:"local"`, `command` (array), `cwd`, `environment`, `disabled`, `codemode`, `timeout{startup,catalog,execution}`, `protocol`, `pool`.
- Remote fields: `type:"remote"`, `url`, `headers`, `oauth{client_id, client_secret, scope, callback_port, redirect_uri, auth_server_metadata_url}` or `false`, plus the shared fields.
- **V1 format is still accepted**: `mcp.<name>` directly, with `enabled: true|false`, a numeric `timeout`, and camelCase `oauth` keys. V2 migrates it in memory as `disabled = !enabled`. V1 and V2 members may be mixed inside `mcp`. If both set the same value, V2 wins. The V1 line (v1.19.x) still ships, and V1 can't read V2-only shapes. **Dark Matter must detect which format a file uses and write in that format.**

### Precedence and merge

Global < project files (farthest → closest) < `.opencode/` files < system < managed. Settings deep-merge in general. For MCP, though, `servers` entries are collected per name with `Map.set`, so the **highest-precedence document's entry replaces the whole entry**. A partial override such as `{ "disabled": true }` alone wouldn't merge with a lower entry, and it would probably fail the schema because `type` and `command` are required. **[src]** To disable a global server for one Project, copy its full definition into the project file with `disabled: true`. The other route is a `permissions` deny rule on `<server>_*`, which blocks the server's tools but still connects it.

### Toggle

Native in-file flag: `"disabled": true` (V2), `"enabled": false` (V1).

### Env and secrets

`{env:VAR}` (empty string when unset) and `{file:path}` (relative to the config file, `~/` supported). Shell-style `$VAR` is not expanded. Secrets are often kept in a separate file through `{file:...}`.

### Write risks

- JSONC: comments and trailing commas are valid, so a write must preserve them. OpenCode itself edits with `jsonc-parser` `modify` + `applyEdits` (`mcp/add.ts`), which keeps comments. Dark Matter should use the same library and approach.
- OpenCode watches its config inputs and hot-reloads MCP on `config.updated` (`config/watch.ts`, `plugin/mcp.ts`). An external write takes effect in running sessions, so a half-written file could be picked up. Write atomically.
- `mcp add` uses a plain `writeFile`, which isn't atomic. Concurrent edits are unlikely, since the Agent rarely writes this file itself.

## Codex CLI

Sources: [Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) (redirected from `developers.openai.com/codex/mcp`), [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference), and in source `openai/codex@6a8a81166a`: `codex-rs/config/src/loader/mod.rs`, `codex-rs/config/src/loader/README.md`, `codex-rs/config/src/merge.rs`, `codex-rs/core/src/config/edit.rs`. Fetched 2026-11-19. Codex isn't installed on this machine, so nothing here was confirmed locally.

### Locations (layers, low → high precedence, from `loader/mod.rs`)

1. Packaged defaults
2. Admin managed preferences (macOS MDM)
3. System: `/etc/codex/config.toml` (`%ProgramData%\OpenAI\Codex\config.toml`)
4. Cloud-managed bundle
5. User: `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`)
6. Profile: `$CODEX_HOME/<name>.config.toml`, when `--profile` is set
7. Project: `.codex/config.toml` in each directory from the repo root down to cwd (the closest wins). These layers are **loaded but disabled when the project is untrusted**. Trust is recorded in user config as `projects."<path>".trust_level = "trusted"`.
8. Runtime: `--config k=v` flags and UI selections
9. Legacy `managed_config.toml` (file and MDM) sits above everything. Separate `requirements.toml` files hold admin constraints.

The MCP docs confirm "project-scoped `.codex/config.toml` (trusted projects only)". Some top-level keys are ignored in project config (`model_providers`, `notify`, `otel`, and others). `mcp_servers` is **not** one of them.

### Schema

```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env = { LOG_LEVEL = "info" }      # literal values
env_vars = ["CONTEXT7_API_KEY"]   # forwarded from the parent env
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "EXAMPLE_TOKEN"
env_http_headers = { "X-Api-Key" = "EXAMPLE_KEY" }
```

Full key list (config reference): `command`, `args`, `env`, `env_vars`, `cwd`, `url`, `auth` (`oauth`|`chatgpt`), `bearer_token_env_var`, `http_headers`, `env_http_headers`, `http_headers_helper`, `oauth.*`, `oauth_resource`, `scopes`, `enabled`, `required`, `startup_timeout_sec`/`_ms`, `tool_timeout_sec`, `enabled_tools`, `disabled_tools`, `default_tools_approval_mode`, `tools.<tool>.approval_mode`, `tools.<tool>.output_token_limit`, `environment_id`, `startup_readiness`, `supports_parallel_tool_calls`, `omit_tools_from`, `tool_input_schema_max_bytes`. Unknown keys are rejected ("unknown configuration field `mcp_servers.x.unknown_key`", from `config_loader_tests.rs`), so a third-party writer must not add its own metadata keys.

### Precedence and merge

Layers fold with `merge_toml_values`: **tables merge recursively, field by field, and scalars and arrays are replaced** (`merge.rs`). **[src]** So a trusted project file with only

```toml
[mcp_servers.context7]
enabled = false
```

should disable a user-level server for that Project and inherit everything else. **[uncertain]** This is inferred from the merge code and wasn't tested. A server defined only in a project file must be complete. In an untrusted project, project-level overrides are silently ignored.

### Toggle

Native in-file flag: `enabled = false` ("disable a server without deleting it"). `required = true` makes startup fail if the server isn't ready. Tool-level filters: `enabled_tools` / `disabled_tools`.

### Env and secrets

Values aren't interpolated. Secrets are kept out of the file by naming environment variables: `env_vars` to forward, `bearer_token_env_var`, and `env_http_headers`. Literal `env` and `http_headers` values also work, and people often paste tokens there. OAuth tokens go to the OS keyring or a file, controlled by `mcp_oauth_credentials_store`.

### Write risks

- TOML with comments. Codex's own writer parses into `toml_edit::DocumentMut` (which keeps comments, ordering and inline-table style), applies edits, and writes atomically with `write_atomically`. It follows symlinks to write the real target (`edit.rs`). Dark Matter should use a format-preserving (CST-based) TOML editor rather than parse-and-stringify. Which Node library to use hasn't been evaluated yet.
- `ReplaceMcpServers` replaces the whole `[mcp_servers]` table, so Codex writes (for example `codex mcp add/remove`) can drop comments inside that table. The app-server tracks per-layer version fingerprints for optimistic concurrency. There's no cross-process file lock, so concurrent writers rely on last-rename-wins. **[src]**
- `config.toml` holds many unrelated settings (models, trust entries, profiles). Edit only `mcp_servers.*`.

## `.agents` convention

**There is no `.agents` convention for MCP Servers.** `.agents/` is used for Skills (`.agents/skills/`, read by OpenCode V2 as a compatibility source and reportedly by Codex and others). AGENTS.md (agents.md) covers instructions only. Some unrelated projects define an `.agents/mcp.json` (for example [Cogo](https://go-steer.github.io/cogo/docs/configuration/agents-directory/) and [oh-my-agent](https://raw.githubusercontent.com/first-fluke/oh-my-agent/HEAD/docs/AGENTS_SPEC.md)), and there's a [proposal gist](https://gist.github.com/mbleigh/27501034a53ba55521519d3bb0a3073f). None of the four v1 Agents reads such a file. **[src]** for OpenCode, which reads only `skills/` from `.agents`. **[doc]** for the others, whose docs name no such path. **[local]** `~/.agents/` here holds only `skills/` and `.skill-lock.json`.

Recommendation: for MCP, treat the `.agents` Agent as having **no MCP Server surface** in v1. If Dark Matter later wants a portable MCP definition, it could be a Dark Matter-owned file that is translated into each Agent's format.

## Out-of-file sources a Scan should report but not edit

- Claude Code: plugin servers (`plugin:<plugin>:<server>`), claude.ai connectors, built-ins (`claude-in-chrome`, `computer-use`), `managedMcpServers`, `--mcp-config` sessions.
- Cursor: team/marketplace and plugin MCPs (the `plugin-*` OAuth keys seen in `state.vscdb`), and the `workbench.customize.primitiveSourceSnapshot.mcps.v3` snapshot.
- OpenCode: plugin- or integration-registered servers (`mcp.transform` editors registered before config).
- Codex: cloud-managed and MDM layers.

## Implications for Dark Matter

1. **One adapter per Agent** maps a normalized MCP Server (`name`, `transport`, `command`/`args` or `url`, `env`, `headers`, `enabled`, `scope`, `source file`) to and from that Agent's format. Dark Matter can't normalize interpolation syntax (`${VAR}`, `${env:VAR}`, `{env:VAR}`, none), so it should keep these strings verbatim.
2. **Toggle strategy differs per Agent:**
   - Codex and OpenCode: flip the native flag in the file.
   - Claude Code: edit the `disabledMcpServers` or `disabledMcpjsonServers` lists.
   - Cursor: there's no safe file-level toggle (needs an ADR).
3. **Format-preserving writers:** `jsonc-parser` for Cursor and OpenCode JSON/JSONC and for Claude `.mcp.json`; a targeted JSON patch for `~/.claude.json`; a CST TOML editor for Codex.
4. **Safe-write protocol for every file:** re-read just before writing, patch only target keys, keep unknown keys, keep file mode, write to a temp file and rename, follow symlinks to the real file. For `~/.claude.json`, warn or retry when Claude Code is running.
5. **Trust gates:** Codex project config and Claude `.mcp.json` approvals only apply in trusted folders. A Scan should show "defined but inactive (untrusted)".

## Open questions to test empirically

- Cursor: which entry wins when global and project define the same name, and what the `mcp-approvals.json` hash is derived from.
- Claude Code: which list `/mcp` writes for a `.mcp.json` server, and whether `~/.claude.json` writes are atomic in 2.1.32x.
- Codex: whether a partial project override with only `enabled = false` actually merges as the source suggests.
- OpenCode: where V2 stores MCP OAuth tokens.
