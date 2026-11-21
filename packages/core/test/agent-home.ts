import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Builds Agent folders in a test's `$HOME` with real files and symlinks.
 * Paths are relative to `home` unless absolute.
 */
export const agentHome = (home: string) => {
  const at = (path: string) => (path.startsWith(sep) ? path : join(home, path));
  return {
    /** Writes `<dir>/SKILL.md` with frontmatter; returns the folder's absolute path. */
    async skill(dir: string, frontmatter: { name?: string; description?: string } = {}, body = "Do the thing.\n") {
      const path = at(dir);
      await mkdir(path, { recursive: true });
      const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
      await writeFile(join(path, "SKILL.md"), `---\n${lines.join("\n")}\n---\n\n${body}`);
      return path;
    },
    /** Creates `path` as a directory symlink to `target`. */
    async link(path: string, target: string) {
      await mkdir(dirname(at(path)), { recursive: true });
      await symlink(at(target), at(path), "dir");
    },
    /** Writes a text file (a config, say), creating its folder. */
    async file(path: string, contents: string) {
      await mkdir(dirname(at(path)), { recursive: true });
      await writeFile(at(path), contents);
      return at(path);
    },
    /**
     * Installs a Claude Code plugin the way `/plugin install` does: its Skills under
     * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/` and an entry
     * in `installed_plugins.json` (version 2).
     */
    async claudePlugin(plugin: string, marketplace: string, version: string, skills: string[]) {
      const installPath = at(`.claude/plugins/cache/${marketplace}/${plugin}/${version}`);
      for (const name of skills)
        await this.skill(join(installPath, "skills", name), { name, description: `${name} from ${plugin}` });
      const registry = at(".claude/plugins/installed_plugins.json");
      const current: { plugins: Record<string, unknown[]> } = await readFile(registry, "utf8").then(
        (text) => JSON.parse(text) as { plugins: Record<string, unknown[]> },
        () => ({ plugins: {} }),
      );
      current.plugins[`${plugin}@${marketplace}`] = [
        { scope: "user", installPath, version, installedAt: "2026-11-01T00:00:00.000Z" },
      ];
      await this.file(".claude/plugins/installed_plugins.json", JSON.stringify({ version: 2, ...current }, null, 2));
    },
    /** Writes `~/.agents/.skill-lock.json` (the `skills` CLI's global lock, version 3). */
    async globalLock(skills: Record<string, { source: string; sourceType?: string }>) {
      const entries = Object.fromEntries(
        Object.entries(skills).map(([name, entry]) => [
          name,
          {
            sourceType: "github",
            sourceUrl: `https://github.com/${entry.source}.git`,
            skillPath: `skills/${name}/SKILL.md`,
            skillFolderHash: "",
            installedAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-01T00:00:00.000Z",
            ...entry,
          },
        ]),
      );
      await mkdir(at(".agents"), { recursive: true });
      await writeFile(at(".agents/.skill-lock.json"), JSON.stringify({ version: 3, skills: entries }, null, 2));
    },
  };
};

/**
 * Every entry under `root` with its type, mode, times, content hash and
 * link target, so a test can assert that nothing was written. Skips `except`
 * (paths relative to `root`).
 */
export const snapshotTree = async (root: string, except: string[] = []) => {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path);
      if (except.includes(rel)) continue;
      const info = await lstat(path);
      const base = `${info.mode}:${info.mtimeMs}:${info.ctimeMs}`;
      if (info.isSymbolicLink()) out[rel] = `link:${base}:${await readlink(path)}`;
      else if (info.isDirectory()) {
        // A folder's times only move when children come and go, which the walk records itself.
        out[rel] = `dir:${info.mode}`;
        await walk(path);
      } else
        out[rel] = `file:${base}:${createHash("sha256")
          .update(await readFile(path))
          .digest("hex")}`;
    }
  };
  await walk(root);
  return out;
};

/** A real git repo at `dir` (via `git init`); returns its absolute path. */
export const gitRepo = async (home: string, dir: string) => {
  const path = dir.startsWith(sep) ? dir : join(home, dir);
  await mkdir(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
  return path;
};

/**
 * Agent history files in a test's `$HOME`, in the shapes the Agents write them
 * (Suggested Projects, #10). Where a format isn't documented the fixture follows
 * what the Agents write today.
 */
export const agentHistory = (home: string) => ({
  /** `~/.claude.json`, whose `projects` map is keyed by absolute folder. */
  async claudeJson(folders: string[]) {
    const projects = Object.fromEntries(folders.map((folder) => [folder, { allowedTools: [], mcpServers: {} }]));
    await writeFile(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, projects }, null, 2));
  },
  /** `~/.claude/projects/<slug>/<session>.jsonl`, each line carrying the session's `cwd`. */
  async claudeSession(folder: string) {
    const dir = join(home, ".claude/projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(dir, { recursive: true });
    const lines = [
      { type: "summary", summary: "Did a thing", leafUuid: "a" },
      { type: "user", cwd: folder, sessionId: "s1", message: { role: "user", content: "hi" } },
    ];
    await writeFile(join(dir, "s1.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  },
  /** Cursor's `workspaceStorage/<hash>/workspace.json` (macOS location), one per folder. */
  async cursorWorkspaces(uris: string[]) {
    const storage = join(home, "Library/Application Support/Cursor/User/workspaceStorage");
    for (const [index, uri] of uris.entries()) {
      await mkdir(join(storage, `hash${index}`), { recursive: true });
      const key = uri.endsWith(".code-workspace") ? "workspace" : "folder";
      await writeFile(join(storage, `hash${index}`, "workspace.json"), JSON.stringify({ [key]: uri }));
    }
  },
  /** OpenCode's `~/.local/share/opencode/opencode.db` with its `project` table. */
  async opencodeProjects(worktrees: string[]) {
    const dir = join(home, ".local/share/opencode");
    await mkdir(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "opencode.db"));
    db.exec("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, time_created INTEGER)");
    const insert = db.prepare("INSERT INTO project (id, worktree, vcs, time_created) VALUES (?, ?, ?, ?)");
    for (const [index, worktree] of worktrees.entries()) insert.run(`p${index}`, worktree, "git", 1);
    db.close();
  },
  /** Codex's `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, whose first line is the `session_meta`. */
  async codexSession(folder: string, name = "rollout-2026-11-20T10-00-00-0001") {
    const dir = join(home, ".codex/sessions/2026/11/20");
    await mkdir(dir, { recursive: true });
    const meta = {
      timestamp: "2026-11-20T10:00:00.000Z",
      type: "session_meta",
      payload: { id: name, timestamp: "2026-11-20T10:00:00.000Z", cwd: folder, originator: "codex_cli_rs" },
    };
    const next = { timestamp: "2026-11-20T10:00:01.000Z", type: "turn_context", payload: { cwd: folder } };
    await writeFile(join(dir, `${name}.jsonl`), `${JSON.stringify(meta)}\n${JSON.stringify(next)}\n`);
  },
});
