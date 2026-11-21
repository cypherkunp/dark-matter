import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

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
