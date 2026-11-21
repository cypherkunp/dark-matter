import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

/** One file in a Skill folder: its `/`-separated path relative to the folder, and its bytes. */
export interface SkillFile {
  path: string;
  content: Buffer;
}

const EXCLUDED_FILES = new Set(["metadata.json"]);
const EXCLUDED_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);

const isExcluded = (name: string, isDirectory: boolean) =>
  EXCLUDED_FILES.has(name) || (isDirectory && EXCLUDED_DIRS.has(name));

/**
 * Every file in a Skill folder. A symlink counts as what it points to; broken,
 * cyclic and outside-the-folder symlinks are skipped. `all` keeps the files the
 * `skills` CLI leaves out of its hash (`metadata.json`, `.git/`, `__pycache__/`).
 */
export const readSkillFiles = async (skillDir: string, { all = false } = {}): Promise<SkillFile[]> => {
  const root = await realpath(skillDir);
  const files: SkillFile[] = [];
  const walk = async (dir: string, prefix: string, ancestors: ReadonlySet<string>) => {
    const real = await realpath(dir);
    if (ancestors.has(real)) return;
    const branch = new Set(ancestors).add(real);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!all && isExcluded(entry.name, entry.isDirectory())) continue;
      const full = join(dir, entry.name);
      const path = prefix + entry.name;
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        const target = await realpath(full).catch(() => null);
        if (!target || (target !== root && !target.startsWith(root + sep))) continue;
        isDirectory = (await stat(target)).isDirectory();
        if (!all && isDirectory && isExcluded(entry.name, true)) continue;
      } else if (!isDirectory && !entry.isFile()) continue;
      if (isDirectory) await walk(full, `${path}/`, branch);
      else files.push({ path, content: await readFile(full) });
    }
  };
  await walk(skillDir, "", new Set());
  return files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
};

/** CRLF folded to LF in text files (no NUL byte); binary files unchanged. */
const normalizeLineEndings = (content: Buffer) =>
  content.includes(0) || !content.includes("\r\n")
    ? content
    : Buffer.from(content.toString("latin1").replaceAll("\r\n", "\n"), "latin1");

/** The skills-lock v2 `computedHash` of a set of files (the `skills` CLI's `hashSkillFiles`). */
export const hashSkillFiles = (files: readonly SkillFile[]): string => {
  const entries = files
    .map((file) => ({ path: Buffer.from(file.path, "utf8"), content: normalizeLineEndings(file.content) }))
    .sort((a, b) => Buffer.compare(a.path, b.path));
  const hash = createHash("sha256");
  for (const { path, content } of entries) {
    hash.update(path);
    hash.update("\0");
    hash.update(String(content.length));
    hash.update("\0");
    hash.update(content);
  }
  return hash.digest("hex");
};

/** The skills-lock v2 `computedHash` of a Skill folder, as `skills check` computes it. */
export const computeSkillFolderHash = async (skillDir: string): Promise<string> =>
  hashSkillFiles(await readSkillFiles(skillDir));

/**
 * A stricter fingerprint than `computedHash`: every file byte for byte, the
 * ones the CLI skips included. Adopt merges two copies only when these match,
 * so removing a copy can never lose anything.
 */
export const fingerprintSkillFolder = async (skillDir: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const file of await readSkillFiles(skillDir, { all: true })) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.content.length));
    hash.update("\0");
    hash.update(file.content);
  }
  return hash.digest("hex");
};
