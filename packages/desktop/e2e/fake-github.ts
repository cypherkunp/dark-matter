import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=Fake", "-c", "user.email=fake@example.com", ...args], { cwd });

/**
 * A minimal GitHub for e2e (#30): one public repo built from `files` in a
 * real git repo under `dir`, served over the REST endpoints Import calls.
 * The core is pointed here with `DARK_MATTER_GITHUB_API`. The full fake,
 * with private repos and rate limits, is core/test/fake-github.ts.
 */
export const startFakeGitHub = async (dir: string, fullName: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["add", "--all"]);
  git(dir, ["commit", "--quiet", "-m", "skills"]);
  let head = git(dir, ["rev-parse", "HEAD"]).toString().trim();
  const resolve = (ref: string) => {
    try {
      return git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
        .toString()
        .trim();
    } catch {
      return null;
    }
  };
  const json = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    const base = `/repos/${fullName}`;
    if (path === base) return json(res, { full_name: fullName, default_branch: "main", private: false });
    const [, kind, ref = ""] = path.slice(base.length).match(/^\/(commits|tarball|git\/trees)\/(.+)$/) ?? [];
    const sha = kind ? resolve(ref) : null;
    if (kind === "commits" && sha) {
      return json(res, {
        sha,
        commit: {
          tree: {
            sha: git(dir, ["rev-parse", `${sha}^{tree}`])
              .toString()
              .trim(),
          },
        },
      });
    }
    if (kind === "tarball" && sha) {
      res.writeHead(200, { "content-type": "application/x-gzip" });
      return res.end(git(dir, ["archive", "--format=tar.gz", `--prefix=${fullName.replace("/", "-")}/`, sha]));
    }
    if (kind === "git/trees" && sha) {
      const tree = git(dir, ["ls-tree", "-r", "-t", sha])
        .toString()
        .trim()
        .split("\n")
        .map((line) => {
          const [meta = "", entry = ""] = line.split("\t");
          const [, type, sha] = meta.split(" ");
          return { path: entry, type, sha };
        });
      return json(res, {
        sha: git(dir, ["rev-parse", `${sha}^{tree}`])
          .toString()
          .trim(),
        tree,
        truncated: false,
      });
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"message":"Not Found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get head() {
      return head;
    },
    /** Commits `files` on main (#33's updates). */
    async commit(changes: Record<string, string>) {
      for (const [path, content] of Object.entries(changes)) await writeFile(join(dir, path), content);
      git(dir, ["add", "--all"]);
      git(dir, ["commit", "--quiet", "-m", "update"]);
      head = git(dir, ["rev-parse", "HEAD"]).toString().trim();
      return head;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
