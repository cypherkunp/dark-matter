import { open, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { claudeDir, claudeJsonFile, codexDir } from "./agent-dirs";
import type { AgentPathEnv } from "./agents";

/**
 * Readers for each Agent's history (#10): where it was run, never what was
 * said. All strictly read-only, and defensive: a missing file, an unknown
 * shape or a bad entry yields nothing rather than an error.
 */

/** Only the head of a session file is read; the `cwd` is near the top. */
const HEAD_BYTES = 64 * 1024;

const readHead = async (path: string): Promise<string> => {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
};

/** The first `"cwd": "…"` in the head of a JSONL session file. */
const cwdIn = async (path: string): Promise<string | null> => {
  try {
    const match = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(await readHead(path));
    if (!match?.[1]) return null;
    const cwd: unknown = JSON.parse(match[1]);
    return typeof cwd === "string" && isAbsolute(cwd) ? cwd : null;
  } catch {
    return null;
  }
};

const list = (dir: string) => readdir(dir).catch(() => [] as string[]);

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

const absolute = (paths: Iterable<unknown>) =>
  [...paths].filter((path): path is string => typeof path === "string" && isAbsolute(path));

const ClaudeJson = z.object({ projects: z.record(z.string(), z.unknown()) });

/**
 * Claude Code: the `projects` map in `~/.claude.json` (keyed by folder), and the
 * session logs in `~/.claude/projects/<slug>/*.jsonl`, whose lines carry the
 * `cwd` (the slug itself is lossy).
 */
export const claudeHistory = async (env: AgentPathEnv): Promise<string[]> => {
  const config = ClaudeJson.safeParse(await readJson(claudeJsonFile(env)));
  const folders = config.success ? absolute(Object.keys(config.data.projects)) : [];
  const sessions = join(claudeDir(env), "projects");
  for (const slug of await list(sessions)) {
    const logs = (await list(join(sessions, slug))).filter((name) => name.endsWith(".jsonl")).sort();
    // One session per folder is enough; try a few in case the first is all summaries.
    for (const log of logs.slice(0, 3)) {
      const cwd = await cwdIn(join(sessions, slug, log));
      if (cwd) {
        folders.push(cwd);
        break;
      }
    }
  }
  return folders;
};

const CursorWorkspace = z.object({ folder: z.string() });

/**
 * Cursor: `workspaceStorage/<hash>/workspace.json`, one per window opened on a
 * folder (`{"folder": "file:///…"}`). Multi-root and remote workspaces are skipped.
 */
export const cursorHistory = async ({ home }: AgentPathEnv): Promise<string[]> => {
  const folders: string[] = [];
  for (const user of [join(home, "Library/Application Support/Cursor/User"), join(home, ".config/Cursor/User")]) {
    const storage = join(user, "workspaceStorage");
    for (const hash of await list(storage)) {
      const workspace = CursorWorkspace.safeParse(await readJson(join(storage, hash, "workspace.json")));
      if (!workspace.success || !workspace.data.folder.startsWith("file://")) continue;
      try {
        folders.push(fileURLToPath(workspace.data.folder));
      } catch {
        // Not a local file URL.
      }
    }
  }
  return folders;
};

/**
 * OpenCode: the `project` table's `worktree` in `opencode.db` (opened read-only),
 * or the older `storage/project/*.json` files.
 */
export const opencodeHistory = async ({ home }: AgentPathEnv): Promise<string[]> => {
  const data = join(home, ".local/share/opencode");
  const folders: string[] = [];
  try {
    const db = new DatabaseSync(join(data, "opencode.db"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT worktree FROM project").all() as { worktree?: unknown }[];
      folders.push(...absolute(rows.map((row) => row.worktree)));
    } finally {
      db.close();
    }
  } catch {
    // No database, or not the shape we know.
  }
  const legacy = join(data, "storage/project");
  for (const name of (await list(legacy)).filter((file) => file.endsWith(".json"))) {
    const project = (await readJson(join(legacy, name))) as { worktree?: unknown } | undefined;
    folders.push(...absolute([project?.worktree]));
  }
  return folders.filter((folder) => folder !== "/");
};

/** Codex: the `cwd` in the `session_meta` line heading each `~/.codex/sessions/**\/rollout-*.jsonl`. */
export const codexHistory = async (env: AgentPathEnv): Promise<string[]> => {
  const sessions = join(codexDir(env), "sessions");
  let files: string[];
  try {
    files = await readdir(sessions, { recursive: true });
  } catch {
    return [];
  }
  const folders = new Set<string>();
  for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
    const cwd = await cwdIn(join(sessions, file));
    if (cwd) folders.add(cwd);
  }
  return [...folders];
};
