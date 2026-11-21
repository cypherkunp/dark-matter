import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";

/** One request the fake served: what a test asserts call counts and auth on. */
export interface FakeRequest {
  method: string;
  path: string;
  authorization: string | null;
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fake",
      GIT_AUTHOR_EMAIL: "fake@example.com",
      GIT_COMMITTER_NAME: "Fake",
      GIT_COMMITTER_EMAIL: "fake@example.com",
    },
  }).trim();

/** `git archive` of a commit as GitHub's tarball endpoint serves it: gzip, one top-level `owner-repo-sha7/` folder. */
const archive = (cwd: string, prefix: string, sha: string) =>
  new Promise<Buffer>((resolve, reject) => {
    execFile(
      "git",
      ["archive", "--format=tar.gz", `--prefix=${prefix}/`, sha],
      { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

export interface FakeRepo {
  readonly fullName: string;
  readonly dir: string;
  /** Writes files (null deletes one) and commits them on `branch` (default: the default branch). Returns the commit SHA. */
  commit(files: Record<string, string | null>, branch?: string): Promise<string>;
  /** Tags the head of the default branch (or `sha`). */
  tag(name: string, sha?: string): void;
  /** The commit a branch or tag points at. */
  head(ref?: string): string;
}

/**
 * GitHub, faked at the HTTP level (#30): the REST endpoints the core calls,
 * answered from real git repos in a temp folder. Tarballs are `git archive`
 * output and tree SHAs are git's own, so they match what GitHub would send.
 * Private repos answer 404 unless the request carries one of `tokens`, as
 * GitHub does.
 */
export const fakeGitHub = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dark-matter-github-")));
  const repos = new Map<string, { repo: FakeRepo; defaultBranch: string; private: boolean }>();
  const requests: FakeRequest[] = [];
  const state = { tokens: new Set<string>(), rateLimited: false };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const resolveRef = (dir: string, ref: string): string | null => {
    try {
      return git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    } catch {
      return null;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const authorization = req.headers.authorization ?? null;
    requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, authorization });
    if (state.rateLimited) {
      return send(
        res,
        403,
        { message: "API rate limit exceeded" },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795000000" },
      );
    }
    const codeload = url.pathname.match(/^\/_codeload\/([^/]+\/[^/]+)\/([0-9a-f]{40})$/);
    if (codeload) {
      const found = repos.get(codeload[1] ?? "");
      if (!found) return send(res, 404, { message: "Not Found" });
      const sha = codeload[2] ?? "";
      const body = await archive(found.repo.dir, `${found.repo.fullName.replace("/", "-")}-${sha.slice(0, 7)}`, sha);
      res.writeHead(200, { "content-type": "application/x-gzip" });
      return res.end(body);
    }
    const match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    const found = match && repos.get(`${match[1]}/${match[2]}`.toLowerCase());
    const token = authorization?.replace(/^(Bearer|token) /, "") ?? null;
    if (!match || !found || (found.private && !(token && state.tokens.has(token)))) {
      return send(res, 404, { message: "Not Found" });
    }
    const { repo, defaultBranch } = found;
    const rest = match[3] ?? "";
    if (rest === "") {
      return send(res, 200, { full_name: repo.fullName, default_branch: defaultBranch, private: found.private });
    }
    const commits = rest.match(/^\/commits\/(.+)$/);
    if (commits) {
      const sha = resolveRef(repo.dir, decodeURIComponent(commits[1] ?? ""));
      if (!sha) return send(res, 422, { message: "No commit found for SHA" });
      return send(res, 200, { sha, commit: { tree: { sha: git(repo.dir, ["rev-parse", `${sha}^{tree}`]) } } });
    }
    const tarball = rest.match(/^\/tarball\/(.+)$/);
    if (tarball) {
      const sha = resolveRef(repo.dir, decodeURIComponent(tarball[1] ?? ""));
      if (!sha) return send(res, 404, { message: "Not Found" });
      // GitHub redirects to codeload; fetch drops the Authorization header on the way.
      res.writeHead(302, { location: `${api}/_codeload/${repo.fullName.toLowerCase()}/${sha}` });
      return res.end();
    }
    const trees = rest.match(/^\/git\/trees\/(.+)$/);
    if (trees) {
      const sha = resolveRef(repo.dir, decodeURIComponent(trees[1] ?? ""));
      if (!sha) return send(res, 404, { message: "Not Found" });
      const lines = git(repo.dir, ["ls-tree", "-r", "-t", sha]).split("\n").filter(Boolean);
      const tree = lines.map((line) => {
        const [meta = "", path = ""] = line.split("\t");
        const [mode, type, object] = meta.split(" ");
        return { path, mode, type, sha: object };
      });
      return send(res, 200, { sha: git(repo.dir, ["rev-parse", `${sha}^{tree}`]), tree, truncated: false });
    }
    return send(res, 404, { message: "Not Found" });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => send(res, 500, { message: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  return {
    /** The API base URL to boot the core with. */
    api,
    requests,
    /** Tokens GitHub accepts for private repos. */
    tokens: state.tokens,
    /** Every request answers 403 rate limited while set. */
    set rateLimited(value: boolean) {
      state.rateLimited = value;
    },
    /** A repo with `files` committed on its default branch. */
    async repo(
      fullName: string,
      files: Record<string, string>,
      options: { defaultBranch?: string; private?: boolean } = {},
    ): Promise<FakeRepo> {
      const dir = join(root, fullName);
      const defaultBranch = options.defaultBranch ?? "main";
      await mkdir(dir, { recursive: true });
      git(dir, ["init", "--quiet", `--initial-branch=${defaultBranch}`]);
      const repo: FakeRepo = {
        fullName,
        dir,
        async commit(changes, branch = defaultBranch) {
          if (git(dir, ["branch", "--show-current"]) !== branch) {
            const exists = resolveRef(dir, `refs/heads/${branch}`) !== null;
            git(dir, exists ? ["checkout", "--quiet", branch] : ["checkout", "--quiet", "-b", branch]);
          }
          for (const [path, content] of Object.entries(changes)) {
            const file = join(dir, path);
            if (content === null) {
              await rm(file, { force: true });
            } else {
              await mkdir(dirname(file), { recursive: true });
              await writeFile(file, content);
            }
          }
          git(dir, ["add", "--all"]);
          git(dir, ["commit", "--quiet", "--allow-empty", "-m", `change ${Object.keys(changes).join(", ")}`]);
          const sha = git(dir, ["rev-parse", "HEAD"]);
          if (branch !== defaultBranch) git(dir, ["checkout", "--quiet", defaultBranch]);
          return sha;
        },
        tag(name, sha) {
          git(dir, ["tag", name, sha ?? "HEAD"]);
        },
        head(ref = defaultBranch) {
          return git(dir, ["rev-parse", `${ref}^{commit}`]);
        },
      };
      await repo.commit(files);
      repos.set(fullName.toLowerCase(), { repo, defaultBranch, private: options.private ?? false });
      return repo;
    },
  };
};

/** A SKILL.md with frontmatter. */
export const skillMd = (name: string, description: string, body = "") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
