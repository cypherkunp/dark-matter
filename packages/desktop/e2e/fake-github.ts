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
  const head = git(dir, ["rev-parse", "HEAD"]).toString().trim();
  const json = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    const base = `/repos/${fullName}`;
    if (path === base) return json(res, { full_name: fullName, default_branch: "main", private: false });
    if (path === `${base}/commits/main` || path === `${base}/commits/${head}`) {
      return json(res, {
        sha: head,
        commit: { tree: { sha: git(dir, ["rev-parse", "HEAD^{tree}"]).toString().trim() } },
      });
    }
    if (path === `${base}/tarball/${head}`) {
      res.writeHead(200, { "content-type": "application/x-gzip" });
      return res.end(git(dir, ["archive", "--format=tar.gz", `--prefix=${fullName.replace("/", "-")}/`, head]));
    }
    if (path === `${base}/git/trees/${head}`) {
      const tree = git(dir, ["ls-tree", "-r", "-t", head])
        .toString()
        .trim()
        .split("\n")
        .map((line) => {
          const [meta = "", entry = ""] = line.split("\t");
          const [, type, sha] = meta.split(" ");
          return { path: entry, type, sha };
        });
      return json(res, { sha: git(dir, ["rev-parse", "HEAD^{tree}"]).toString().trim(), tree, truncated: false });
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"message":"Not Found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    head,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
