import { execFile } from "node:child_process";
import { relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Which of `paths` (absolute, inside `project`) git tracks: the path itself (a
 * file or symlink) or any file under it. Only reads. Outside a git repo, or if
 * git isn't there, nothing is tracked.
 */
export const gitTrackedPaths = async (project: string, paths: readonly string[]): Promise<Set<string>> => {
  const inside = paths.filter((path) => path.startsWith(project + sep));
  if (inside.length === 0) return new Set();
  let listed: string[];
  try {
    const { stdout } = await run(
      "git",
      ["-C", project, "ls-files", "-z", "--", ...inside.map((path) => relative(project, path))],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    listed = stdout.split("\0").filter(Boolean);
  } catch {
    return new Set();
  }
  return new Set(
    inside.filter((path) => {
      const rel = relative(project, path).split(sep).join("/");
      return listed.some((file) => file === rel || file.startsWith(`${rel}/`));
    }),
  );
};
