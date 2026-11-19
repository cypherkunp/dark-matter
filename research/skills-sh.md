# How skills.sh search, install and skills-lock.json work

Research for [#4](https://github.com/cypherkunp/dark-matter/issues/4). Researched 2026-11-19.

All source citations point at the `skills` CLI at
[vercel-labs/skills@57217cf](https://github.com/vercel-labs/skills/tree/57217cf86ba38148a57af9e90d14a4c049558330)
(package.json `1.9.0`, which is also the version published on npm). Code links are permalinks to that commit.

## TL;DR

- **Search API: yes, two of them.** The unauthenticated `GET https://skills.sh/api/search?q=` is
  what the CLI uses. It is capped at **30 requests/minute per IP** (verified: request 31 got a
  `429` with `Retry-After: 60`). The documented, official API is `GET https://skills.sh/api/v1/...`
  (search, leaderboard, curated, detail with file contents, security audits). It allows 600 req/min,
  but it **only authenticates with a Vercel OIDC token**, which a desktop app can't get.
- **`skills-lock.json` v2** is a flat map of installed name to `{source, sourceType, commit?, ref?,
  skillPath?, computedHash, ...}` with no timestamps. `computedHash` is a SHA-256 over the installed
  folder's files: sorted by UTF-8 path bytes, framed as `path NUL len NUL content`, CRLF folded to LF
  in text files. I reimplemented it and it reproduces all three hashes in this repo's lock.
- **The CLI already uses a canonical store plus symlinks**: one real copy in `.agents/skills/<name>`
  (project) or `~/.agents/skills/<name>` (global), with symlinks from agent-specific folders like
  `.claude/skills/<name>`. Cursor, OpenCode and Codex read `.agents/skills` directly in projects.
- **Recommendation:** call the public HTTP API directly for search and metadata (cache, throttle,
  degrade gracefully). Use the CLI's **programmatic library API** (`import { resolveSource,
  installSkills } from 'skills'`) to fetch skill files into the Library, rather than shelling out
  to `npx` or reimplementing fetch. Reimplement only the hash, which is small and fully specified.
  Dark Matter does its own Linking.

## 1. Which package and repo

- npm `skills` 1.9.0: `repository: git+https://github.com/vercel-labs/skills.git`, license MIT,
  bins `skills` and `add-skill` (`npm view skills`). It requires Node `>=22.20.0` and is ESM only.
- skills.sh is a Vercel-run directory ("Made with care by Vercel"). The CLI is MIT
  ([LICENSE](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/LICENSE), "Copyright (c) 2026 Vercel, Inc.").

## 2. Search

### 2a. What the CLI calls (unauthenticated)

[`src/find.ts` L13, L66-L92](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/find.ts#L66-L92):

```
GET ${SKILLS_API_URL || 'https://skills.sh'}/api/search?q=<query>[&owner=<gh-owner>]
```

Live response (`q=shadcn`), with fields abridged:

```json
{
  "query": "shadcn", "searchType": "fuzzy", "searchVersion": "algolia",
  "count": 100, "duration_ms": 329, "timings_ms": { "...": 0 },
  "skills": [
    { "id": "shadcn-ui/ui/shadcn", "source": "shadcn-ui/ui", "skillId": "shadcn",
      "name": "shadcn", "installs": 425150 }
  ]
}
```

What I verified against the live service:

- `q` must be at least 2 characters, otherwise `400 {"error":"Query must be at least 2 characters"}`.
- `limit=N` is honoured. The default is up to 100 results. `owner=` scopes the search to one GitHub
  owner.
- The search is Algolia-backed (`x-search-version: algolia`). Every term must match, which is why
  the CLI re-queries with one term dropped at a time when fewer than 10 results come back
  ([find.ts L94-L140](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/find.ts#L94-L140)).
- **Rate limit:** after about 30 requests in a minute it returns
  `429 {"error":"rate_limit_exceeded","message":"Rate limit exceeded. Maximum 30 requests per minute.
  For higher limits, use the official API at /api/v1/ with an API key."}` with `Retry-After: 60`.
  No `X-RateLimit-*` headers are sent on this endpoint.
- `id` is `{source}/{slug}`, and the skills.sh page is `https://skills.sh/{id}`.

### 2b. Official API (`/api/v1`)

Docs: <https://www.skills.sh/docs/api>.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/skills?view=all-time\|trending\|hot&page=&per_page=(1-500)&source=` | Leaderboard. Returns `{data, pagination:{page,perPage,total,hasMore}}` |
| `GET /api/v1/skills/search?q=&limit=(1-200, default 50)&owner=` | Search. Returns `{data, query, searchType: fuzzy\|semantic, count, durationMs}` |
| `GET /api/v1/skills/curated` | Data behind skills.sh/official, grouped by owner |
| `GET /api/v1/skills/{source}/{skill}` (or `/{id}`) | Detail: `{id, source, slug, installs, hash, files:[{path,contents}]\|null}` |
| `GET /api/v1/skills/audit/{source}/{skill}` | Partner security audits (Gen Agent Trust Hub, Socket, Snyk, Runlayer, ZeroLeaks): `status pass/warn/fail`, `riskLevel` |

The skill object has `id, slug, name, source, installs, sourceType ("github"|"well-known"),
installUrl (for npx skills add), url, isDuplicate?`.

- **Auth:** `Authorization: Bearer <VERCEL_OIDC_TOKEN>`. The docs say "no signup, no API key". The
  only documented way to get a token is to run as a Vercel-deployed project (or `vercel env pull`,
  which lasts about 12 hours). Without one, `GET /api/v1/skills` returns
  `401 {"error":"authentication_required", ...}`.
- **Limits:** 600 req/min per (team, project), with `X-RateLimit-Limit/Remaining/Reset` headers.
  Server cache is 30-60 s for search and leaderboard, 5 min for detail and curated.
- **Implication:** a shipped Electron app can't use v1 without a Vercel-hosted proxy of our own.
  That would make us a service operator, and every user would share one (team, project) quota.

### 2c. Download (unauthenticated)

The CLI's fast install path, [`src/blob.ts` L515-L533](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/blob.ts#L515-L533):

```
GET ${SKILLS_DOWNLOAD_URL || 'https://skills.sh'}/api/download/<owner>/<repo>/<slug>
-> { "files": [{ "path": "SKILL.md", "contents": "..." }, ...], "hash": "<sha256>" }
```

This was live-verified for `shadcn-ui/ui/shadcn`. The CLI does **not** trust that response
outright:

- it hashes the files locally ([L545-L551](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/blob.ts#L545-L551), "Hash locally rather than
  trusting download.hash");
- it checks the snapshot against the GitHub Trees API for the current commit, and falls back to
  `git clone --depth 1` if any download is missing or stale ([L735-L785](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/blob.ts#L735-L785)).

Skill discovery itself goes through the GitHub Trees API plus `raw.githubusercontent.com`, so the
GitHub anonymous limit (60 req/h) also applies. The CLI retries with `GITHUB_TOKEN` or `gh api`,
then falls back to cloning.

### 2d. Telemetry

`add`, `remove`, `update` and `find` send events to `https://www.skills.sh/tele/t`, and installs
also trigger `.../tele/audit` ([`src/telemetry.ts` L3-L4](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/telemetry.ts#L3-L4)). **Install
counts on skills.sh come from this telemetry.** `DISABLE_TELEMETRY=1` or `DO_NOT_TRACK=1` turns it
off, and the programmatic API takes `telemetry: false`. Identifiers are sent only for repos GitHub
confirms are public ([docs/troubleshooting.md](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/docs/troubleshooting.md#telemetry)).

## 3. CLI behaviour: `npx skills find` / `add`

- `skills find <query> [--owner o]` is non-interactive. It prints `owner/repo@skill  N installs`
  and `└ https://skills.sh/<id>`, then exits. There is no `--json` flag. With no query it opens an
  fzf-style prompt, except in non-TTY or detected-agent contexts, where it prints usage and exits
  ([find.ts L360-L420](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/find.ts)).
- `skills add <source>` accepts `owner/repo`, `owner/repo@skill`, GitHub/GitLab/git URLs, `#ref`,
  well-known endpoints (`https://host/.well-known/agent-skills/index.json`) and local paths.
  Options: `-g` global, `-a <agents>`, `-s <skills|'*'>`, `-l` list only, `--copy`,
  `--rename`, `-y`, `--all`. Fetch order: blob snapshot (GitHub only), then a shallow git clone
  ([add.ts L1638-L1751](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/add.ts#L1638)). Other commands are `list`, `check` (exits 1 on
  updates or local edits), `update`, `remove`, `use`, `init`, and `experimental_install` (restore
  from the lock, `--frozen-lockfile`). See [docs/commands.md](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/docs/commands.md).
- **Programmatic API** ([docs/api.md](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/docs/api.md)): `getSupportedAgents`, `detectAgents`,
  `resolveSource`, `installSkills`, `listSkills`, `removeSkills`. It never prompts, prints or
  exits, reports progress through `onProgress` and `onWarning`, and throws typed diagnostics. It
  explicitly supports "installing into a plain directory": `agents: ['universal'], mode: 'copy',
  lockfile: false, telemetry: false, symlinks: 'reject'`. **There is no search function in it.**

## 4. `skills-lock.json` v2 schema

Source: [`src/local-lock.ts` L23-L103](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/local-lock.ts#L23-L103). The file lives at
`<project>/skills-lock.json` and is meant to be committed.

```ts
interface LocalSkillLockFile {
  version: number;                          // 2 (v1 is migrated on read; others throw SKILLS_INVALID_LOCAL_LOCK)
  skills: Record<string, LocalSkillLockEntry>; // key = installed name; written sorted A-Z
}
interface LocalSkillLockEntry {
  source: string;        // "owner/repo", npm package name, or a lock-relative local path ("./x")
  sourceUrl?: string;    // original remote URL when `source` was normalized
  ref?: string;          // branch/tag requested
  commit?: string;       // git commit installed; restore fetches this SHA, `update` advances it
  sourceType: string;    // "github" | "gitlab" | "git" | "node_modules" | "local" | "well-known" ...
  skillPath?: string;    // path to SKILL.md inside the source ("skills/shadcn/SKILL.md")
  skillName?: string;    // upstream name when installed via --rename
  version?: string;      // npm package version (node_modules sources)
  via?: string;          // package whose package.json `skills` field requested it ("." = project)
  computedHash: string;  // see section 5; "" when a v1 entry could not be verified
  subagents?: string[];  // Eve-specific placement
  wellKnownDigest?: string;
  installMode?: 'copy';  // only when the user chose copies over symlinks
}
```

- There are no timestamps, so that git merges stay clean. Writes are atomic (tmp file plus rename)
  and serialized through a `skills-lock.json.lock` mutex file.
- State check ([L235-L247](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/local-lock.ts#L235-L247)): `missing` means there is no
  `SKILL.md` in `.agents/skills/<name>`. `modified` means the hash differs or is empty. Otherwise the
  state is `tracked`.
- The **global** lock is a different file and schema: `~/.agents/.skill-lock.json` (or
  `$XDG_STATE_HOME/skills/.skill-lock.json`) at **version 3**, with `sourceUrl`, `skillFolderHash`
  (a GitHub tree SHA), `installedAt`/`updatedAt`, `pluginName`, `dismissed` and
  `lastSelectedAgents` ([`src/skill-lock.ts` L7-L81](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/skill-lock.ts#L7-L81)).

## 5. How `computedHash` is computed

Code: [`src/skill-hash.ts` L11-L113](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/skill-hash.ts#L11-L113)
(`hashSkillFiles`, `computeSkillFolderHash`). The README spec is at
[README "Lock File Content Hash"](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/README.md#lock-file-content-hash).

1. Walk the **installed** skill folder. Skip files named `metadata.json` and folders named `.git`,
   `__pycache__` and `__pypackages__`. A symlink counts as its target. Symlinks that are broken,
   cyclic or point outside the folder are skipped.
2. The path is relative to the folder and uses `/` separators.
3. In a text file (one with no NUL byte), each `\r\n` becomes `\n`.
4. Sort by `Buffer.compare` of the UTF-8 path bytes, which is not locale-aware. v1 used
   `localeCompare` and had no framing, which is why v2 exists.
5. Compute `sha256( for each file: path ‖ 0x00 ‖ ascii(len(content)) ‖ 0x00 ‖ content )`, as
   lowercase hex.

Test vectors from the README: an empty folder gives `e3b0c442…b855`, and `SKILL.md`=`# hi\n` gives
`93c36952…2f55`.

**Verified locally:** an independent Python reimplementation (about 30 lines) reproduces all three
`computedHash` values in this repo's `skills-lock.json` from `.agents/skills/*`. Because the hash
covers the installed output, a `--rename` install hashes the rewritten frontmatter.

Don't confuse it with `computeSkillsShTreeHash` (`skills-sh-tree-v2`,
[`src/skills-sh-hash.ts`](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/skills-sh-hash.ts)). That one is used for skills.sh "pack" pins
and works differently: it is text-only, skips binaries and symlinks, and uses different
exclusions. The `hash` field from `/api/download` and the v1 detail endpoint is the server's own
value. The CLI does not use it as `computedHash`.

## 6. Where it installs, and the symlink model

[`src/installer.ts` L39-L44, L116-L159, L320-L480](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/installer.ts#L320-L480);
[`src/agents.ts`](https://github.com/vercel-labs/skills/blob/57217cf86ba38148a57af9e90d14a4c049558330/src/agents.ts).

**Canonical dir:** `<cwd>/.agents/skills/<name>` (project) or `~/.agents/skills/<name>` (`-g`).

**Modes** (`InstallMode`):

- `symlink` (the default and recommended mode): copy into the canonical dir once, then symlink
  each agent's dir to it. Links are relative on POSIX and junctions on Windows. If the symlink
  fails it falls back to a copy (`symlinkFailed: true`).
- `copy`: copy straight into every agent dir. The lock records `installMode: 'copy'`.
- `link`: make the canonical dir itself a symlink to the source (for local paths), then link the
  agents to it.

**Universal agents** are agents whose project `skillsDir` is `.agents/skills`. They read the
canonical dir directly, so they get no extra link. Globally, they also read `~/.agents/skills`
unless `globalReadsCanonical: false` is set (Antigravity has it).

Dark Matter's v1 agents:

| Agent | Project dir | Global dir | Project install | Global install |
| --- | --- | --- | --- | --- |
| Claude Code | `.claude/skills` | `$CLAUDE_CONFIG_DIR` or `~/.claude/skills` | symlink → `.agents/skills/<n>` (dir always created) | symlink → `~/.agents/skills/<n>` |
| Cursor | `.agents/skills` (universal) | `~/.cursor/skills` | canonical only | canonical `~/.agents/skills` only |
| OpenCode | `.agents/skills` (universal) | `$XDG_CONFIG_HOME` or `~/.config/opencode/skills` | canonical only | canonical only |
| Codex | `.agents/skills` (universal) | `~/.agents/skills` | canonical only | canonical only |
| `universal` (`.agents`) | `.agents/skills` | `$XDG_CONFIG_HOME` or `~/.config/agents/skills` | canonical only | canonical only |

- For project installs, non-universal agents whose root folder (for example `.windsurf/`) doesn't
  exist in the project are skipped (`skipReason: 'missing-agent-project-directory'`). Claude Code
  is the exception: it sets `createProjectSkillsDirByDefault`.
- The installer resolves symlinked parents. If `~/.claude/skills` is itself a symlink to
  `~/.agents/skills`, it won't delete the canonical copy.

**Overlap with Dark Matter.** The CLI's `.agents/skills` canonical dir is the same idea as our
**Library**, plus **Links**, but it is one store per scope (each project, plus `~/.agents`), not one
store per machine. If Dark Matter **Links** `~/.claude/skills/x` to `~/.dark-matter/...`, a later
`npx skills add -g` would `rm -rf` and relink that path to `~/.agents/skills/x`. It refuses only for
"category" dirs. Also, `~/.agents/skills` and project `.agents/skills` are themselves read by
Cursor, OpenCode and Codex, so Dark Matter has to treat them as an Agent skill folder that gets
Links, not as a Library. The decisions that follow from this are listed under Open questions below.

## 7. Licensing and ToS

- **CLI code:** MIT (Vercel). We can depend on it, bundle it or fork it, keeping the notice.
  `ThirdPartyNoticeText.txt` lists its dependencies.
- **skills.sh ToS** (<https://www.skills.sh/terms>), quoted verbatim:
  - "Use of the public API is rate-limited per IP. Programmatic abuse, scraping that bypasses the
    rate limit, or use that materially degrades service for others may result in IP-level blocks.
    Reasonable use, including caching results on your own infrastructure, is encouraged and not
    restricted."
  - "Skills shown in the directory are the property of their authors and distributed under the
    licenses present in the source repositories. We do not own, host, or relicense skill content."
  - "The site, the CLI, and the public API are provided "as is" without warranty of any kind."
  - "Always review a skill's SKILL.md and source repository before installing it…"
  - Terms may change; "continued use of the site after changes constitutes acceptance."
- The terms have no clause against third-party clients and no attribution requirement. Each Skill
  keeps its own repo licence, so Dark Matter should show the licence and source, and must not
  re-host skill content. A per-user local Library is fine. Takedowns happen on the skills.sh side,
  so handle skills that have been delisted.
- **The constraint that matters is rate limits.** Each Dark Matter install calls from the user's
  own IP, so 30 req/min per user is plenty if search-as-you-type is debounced (about 300 ms),
  responses are cached, and `429`/`Retry-After` is honoured.

## 8. Recommendation

| Option | Search | Install | Verdict |
| --- | --- | --- | --- |
| Call HTTP API directly | `/api/search` works and is fast. v1 is unusable without Vercel OIDC | `/api/download` lacks a commit, so it still needs GitHub verification | **Use for search and browse** |
| Shell out to `npx skills` | No JSON output, parses ANSI text, needs network npm, prompts | Installs into agent dirs with its own symlinks, which fights the Library | **Avoid** |
| Use `skills` as a library (Electron main process) | n/a | `resolveSource` + `installSkills({agents:['universal'], mode:'copy', lockfile:false, telemetry:false, symlinks:'reject'})` into a staging dir, then move it into the Library | **Use for fetch** |
| Reimplement | Trivial (a single GET) | GitHub trees, clones, well-known, GitLab, private-repo auth, submodules, … too much | Only the **hash** (and optionally a lock reader/writer) |

Concretely:

1. **Search:** a `SkillsShClient` in main calls `GET https://skills.sh/api/search?q&owner&limit`.
   Debounce it, cache it with an LRU of about 60 s, and back off on 429. Use the `id` as the key
   and link to `https://skills.sh/{id}`. Show the install count. Keep the base URL configurable,
   like `SKILLS_API_URL`. If Vercel ever opens v1 keys to non-Vercel clients, switch to it for
   audits and file previews.
2. **Install:** depend on `skills` (pin an exact version, since it is ESM and needs Node 22.20 or
   later, which Electron's Node must meet). Fetch into a temp dir with the options above, then
   move the folder into the Library and create our own Links. Record provenance (`source`,
   `sourceType`, `commit`, `skillPath`, `computedHash`) in the same shape as a lock v2 entry, so a
   Library Skill can be compared with any project's `skills-lock.json`.
3. **Hash:** port `hashSkillFiles` (or import `computeSkillFolderHash`) so Scan can mark project
   skills `tracked`/`modified`/`missing` against `skills-lock.json` exactly as `skills check` does.
4. **Telemetry:** default it to off (`telemetry: false`). Offer an opt-in to "count my installs on
   skills.sh", because the leaderboard depends on that telemetry.

### Open questions for the map

- When Dark Matter manages a Project that has `skills-lock.json`, should Dark Matter write that
  lock (so `npx skills experimental_install` keeps working for teammates), or leave it read-only?
- `~/.agents/skills` is read globally by Cursor, Codex and OpenCode. Should it be Linked from the
  Library (one link per Skill), or should the whole directory be Adopted?
- How should Dark Matter coexist with users who keep running `npx skills add -g`? That command
  replaces our Links with ones that point at `~/.agents/skills`. One option is for Scan to detect
  this and offer to Adopt.

## Sources

- skills CLI source: <https://github.com/vercel-labs/skills> (at `57217cf`). Files: `src/find.ts`,
  `src/blob.ts`, `src/local-lock.ts`, `src/skill-hash.ts`, `src/skills-sh-hash.ts`,
  `src/skill-lock.ts`, `src/installer.ts`, `src/agents.ts`, `src/telemetry.ts`, `README.md`,
  `docs/api.md`, `docs/commands.md`, `docs/troubleshooting.md`
- npm: <https://www.npmjs.com/package/skills>
- API docs: <https://www.skills.sh/docs/api>
- Terms: <https://www.skills.sh/terms>
- Live endpoints probed: `https://skills.sh/api/search`, `https://skills.sh/api/download/shadcn-ui/ui/shadcn`,
  `https://skills.sh/api/v1/skills` (401)
