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

/** A file found by `walkSkillFolder`: its `/`-separated relative path and where to read it. */
interface FoundFile {
  path: string;
  full: string;
}

/**
 * Every file in a Skill folder, without reading it. A symlink counts as what
 * it points to; broken, cyclic and outside-the-folder symlinks are skipped.
 * `all` keeps the files the `skills` CLI leaves out of its hash.
 */
const walkSkillFolder = async (skillDir: string, all: boolean): Promise<FoundFile[]> => {
  const root = await realpath(skillDir);
  const files: FoundFile[] = [];
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
      else files.push({ path, full });
    }
  };
  await walk(skillDir, "", new Set());
  return files;
};

/**
 * Every file in a Skill folder. A symlink counts as what it points to; broken,
 * cyclic and outside-the-folder symlinks are skipped. `all` keeps the files the
 * `skills` CLI leaves out of its hash (`metadata.json`, `.git/`, `__pycache__/`).
 */
export const readSkillFiles = async (skillDir: string, { all = false } = {}): Promise<SkillFile[]> => {
  const found = await walkSkillFolder(skillDir, all);
  const files = await Promise.all(found.map(async ({ path, full }) => ({ path, content: await readFile(full) })));
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

/** Hashes by Skill folder (real path), each with the stat signature of the files it was computed from. */
const hashCache = new Map<string, { signature: string; hash: string }>();
const HASH_CACHE_LIMIT = 4096;

/** Paths, sizes and mtimes of the hashed files: a changed signature means the hash is stale. */
const signatureOf = async (skillDir: string) => {
  const found = await walkSkillFolder(skillDir, false);
  const parts = await Promise.all(
    found.map(async ({ path, full }) => {
      const info = await stat(full, { bigint: true });
      return `${path}\0${info.size}\0${info.mtimeNs}\0${info.ino}`;
    }),
  );
  return parts.sort().join("\n");
};

/**
 * `computeSkillFolderHash` with a cache (#42), for the Library's Modified (#34)
 * and Copy status (#28) on every query. An entry is reused while its folder's
 * file list, sizes and mtimes are unchanged (a stat walk, no reads), and the
 * watcher drops entries under paths that changed (`forgetSkillHashes`).
 */
export const cachedSkillFolderHash = async (skillDir: string): Promise<string> => {
  const real = await realpath(skillDir);
  const signature = await signatureOf(real);
  const cached = hashCache.get(real);
  if (cached?.signature === signature) return cached.hash;
  const hash = await computeSkillFolderHash(real);
  hashCache.delete(real);
  hashCache.set(real, { signature, hash });
  if (hashCache.size > HASH_CACHE_LIMIT) {
    const oldest = hashCache.keys().next().value;
    if (oldest !== undefined) hashCache.delete(oldest);
  }
  return hash;
};

/** Drops cached hashes of folders at, inside or around any of `paths` (they changed on disk). */
export const forgetSkillHashes = (paths: readonly string[]) => {
  for (const folder of hashCache.keys()) {
    const prefix = folder + sep;
    if (paths.some((path) => path === folder || path.startsWith(prefix) || folder.startsWith(path + sep)))
      hashCache.delete(folder);
  }
};

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
