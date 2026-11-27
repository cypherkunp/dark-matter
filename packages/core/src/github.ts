import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { delimiter } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { type GitHubAuthMethod, RateLimited, SourceUnreachable } from "@dark-matter/contracts";
import { x as extractTar } from "tar";
import { describeFetchError } from "./fetch-error";
import type { SecretStore } from "./secrets";

/** How the core reaches GitHub. Tests and e2e pass the fake's `api` and a `ghToken` that never runs `gh`. */
export interface GitHubOptions {
  /** The REST API base URL. Default: https://api.github.com. */
  api?: string;
  /** The `gh` CLI's token, or null when it isn't logged in. Default: `gh auth token`. */
  ghToken?: () => Promise<string | null>;
}

/** The keychain account holding the GitHub PAT; not `<server>.<key>`, so it never collides with an MCP Secret. */
export const GITHUB_PAT_SECRET = "github-pat";

const GITHUB_API = "https://api.github.com";

/** `gh auth token`, looking in the usual install folders too (an app launched from the Dock has a short PATH). */
const runGhAuthToken = (): Promise<string | null> =>
  new Promise((resolve) => {
    const path = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(delimiter);
    execFile(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      { timeout: 5000, encoding: "utf8", env: { ...process.env, PATH: path } },
      (error, stdout) => resolve(error ? null : stdout.trim() || null),
    );
  });

/** The core's GitHub options from its environment: `DARK_MATTER_GITHUB_API` points it at a fake and turns `gh` off. */
export const githubOptionsFrom = (env: { DARK_MATTER_GITHUB_API?: string | undefined }): GitHubOptions =>
  env.DARK_MATTER_GITHUB_API ? { api: env.DARK_MATTER_GITHUB_API, ghToken: async () => null } : {};

/** A 404 (or 422 for a ref): the repo, ref or path is gone, renamed or private. Updates (#33) mark Skills Orphaned on it. */
export class GitHubNotFound extends SourceUnreachable {}

/** The rate limit GitHub reported on its last answer. */
export interface GitHubRateLimit {
  remaining: number;
  limit: number | null;
  resetAt: string | null;
}

/** A tree URL's `<ref>/<path>` split where the ref really ends (#33): branch names may contain `/`. */
export interface ResolvedTreeRef {
  ref: string;
  refType: "branch" | "tag" | "commit";
  subpath: string | null;
}

export interface GitHubRepo {
  /** `owner/repo` as GitHub spells it. */
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

/** One entry of a recursive Trees API listing. */
export interface GitHubTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

/**
 * A GitHub REST client bound to one set of credentials, made per operation by
 * `GitHubAccess.session()`. Every call is one request; update checks (#33)
 * need `commit` (the tracked ref's head) and `tree` (folder tree SHAs).
 */
export class GitHubSession {
  constructor(
    readonly api: string,
    readonly auth: GitHubAuthMethod,
    private readonly token: string | null,
  ) {}

  /** The rate limit from the last response, if GitHub sent one. */
  rateLimit: GitHubRateLimit | null = null;

  #noteRateLimit(response: Response) {
    const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? Number.NaN);
    if (!Number.isFinite(remaining)) return;
    const limit = Number(response.headers.get("x-ratelimit-limit") ?? Number.NaN);
    const reset = Number(response.headers.get("x-ratelimit-reset") ?? Number.NaN);
    this.rateLimit = {
      remaining,
      limit: Number.isFinite(limit) ? limit : null,
      resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
    };
  }

  async #get(path: string, what: string, accept = "application/vnd.github+json"): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: accept,
      "User-Agent": "dark-matter",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await fetch(`${this.api}${path}`, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new SourceUnreachable(what, describeFetchError(error));
    }
    this.#noteRateLimit(response);
    if (response.ok) return response;
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 429 || (response.status === 403 && remaining === "0")) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      throw new RateLimited(Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null);
    }
    if (response.status === 404 || response.status === 422) {
      throw new GitHubNotFound(
        what,
        this.token
          ? "not found, or your token can't see it"
          : "not found (private repos need `gh auth login` or a token)",
      );
    }
    throw new SourceUnreachable(what, `GitHub answered ${response.status}`);
  }

  async repo(fullName: string): Promise<GitHubRepo> {
    const body = (await (await this.#get(`/repos/${fullName}`, fullName)).json()) as {
      full_name: string;
      default_branch: string;
      private: boolean;
    };
    return { fullName: body.full_name, defaultBranch: body.default_branch, private: body.private };
  }

  /** The commit a branch, tag or SHA points at, and its root tree. */
  async commit(fullName: string, ref: string): Promise<{ sha: string; tree: string }> {
    const body = (await (
      await this.#get(`/repos/${fullName}/commits/${encodeURIComponent(ref)}`, `${fullName}@${ref}`)
    ).json()) as { sha: string; commit: { tree: { sha: string } } };
    return { sha: body.sha, tree: body.commit.tree.sha };
  }

  /** Every entry under a commit, recursively, plus the root tree SHA. */
  async tree(fullName: string, sha: string): Promise<{ sha: string; entries: GitHubTreeEntry[] }> {
    const body = (await (
      await this.#get(`/repos/${fullName}/git/trees/${sha}?recursive=1`, `${fullName}@${sha.slice(0, 7)}`)
    ).json()) as { sha: string; tree: GitHubTreeEntry[] };
    return { sha: body.sha, entries: body.tree };
  }

  /** Refs under `refs/<kind>/` that start with `prefix` (GitHub's matching-refs), without the `refs/<kind>/` part. */
  async matchingRefs(fullName: string, kind: "heads" | "tags", prefix: string): Promise<string[]> {
    const path = prefix.split("/").map(encodeURIComponent).join("/");
    const body = (await (
      await this.#get(`/repos/${fullName}/git/matching-refs/${kind}/${path}`, `${fullName}@${prefix}`)
    ).json()) as { ref: string }[];
    return body.map((entry) => entry.ref.replace(`refs/${kind}/`, ""));
  }

  /**
   * Splits a tree URL's `<ref>/<path>` (or a bare ref) where the ref ends. A
   * branch may contain `/`, so the longest branch or tag that is a prefix of
   * the path wins (git forbids `a` and `a/b` both being branches). Two calls:
   * branches and tags starting with the first segment. A 40-hex SHA is a commit.
   */
  async resolveTreeRef(fullName: string, treePath: string): Promise<ResolvedTreeRef> {
    const segments = treePath.split("/").filter(Boolean);
    const first = segments[0] ?? "";
    const split = (ref: string, refType: ResolvedTreeRef["refType"]): ResolvedTreeRef => {
      const rest = segments.slice(ref.split("/").length).join("/");
      return { ref, refType, subpath: rest || null };
    };
    if (/^[0-9a-f]{40}$/.test(first)) return split(first, "commit");
    const longest = (refs: string[]) =>
      refs.filter((ref) => treePath === ref || treePath.startsWith(`${ref}/`)).sort((a, b) => b.length - a.length)[0] ??
      null;
    const branch = longest(await this.matchingRefs(fullName, "heads", first));
    if (branch) return split(branch, "branch");
    const tag = longest(await this.matchingRefs(fullName, "tags", first));
    if (tag) return split(tag, "tag");
    throw new GitHubNotFound(`${fullName}@${first}`, "no such branch or tag");
  }

  /** Downloads a commit's tarball and unpacks it into `dir` (GitHub's top-level folder stripped). */
  async download(fullName: string, sha: string, dir: string): Promise<void> {
    const response = await this.#get(`/repos/${fullName}/tarball/${sha}`, `${fullName}@${sha.slice(0, 7)}`);
    if (!response.body) throw new SourceUnreachable(fullName, "GitHub sent an empty archive");
    await mkdir(dir, { recursive: true });
    // node-tar refuses absolute paths and `..` entries, so nothing lands outside `dir`.
    await pipeline(Readable.fromWeb(response.body as ReadableStream), extractTar({ cwd: dir, strip: 1 }));
  }
}

/** Resolves GitHub credentials in the decided order (#11): `gh auth token`, then the keychain PAT, then anonymous. */
export class GitHubAccess {
  readonly api: string;
  readonly #ghToken: () => Promise<string | null>;

  constructor(
    options: GitHubOptions,
    private readonly secrets: SecretStore,
  ) {
    this.api = (options.api ?? GITHUB_API).replace(/\/+$/, "");
    this.#ghToken = options.ghToken ?? runGhAuthToken;
  }

  async #credentials(): Promise<{ method: GitHubAuthMethod; token: string | null }> {
    const gh = await this.#ghToken().catch(() => null);
    if (gh) return { method: "gh", token: gh };
    const pat = await this.secrets.get(GITHUB_PAT_SECRET).catch(() => null);
    if (pat) return { method: "pat", token: pat };
    return { method: "anonymous", token: null };
  }

  /** A client with the credentials to use right now. */
  async session(): Promise<GitHubSession> {
    const { method, token } = await this.#credentials();
    return new GitHubSession(this.api, method, token);
  }

  async status(): Promise<{ method: GitHubAuthMethod; pat: boolean }> {
    const { method } = await this.#credentials();
    const pat = method === "pat" || (await this.secrets.get(GITHUB_PAT_SECRET).catch(() => null)) !== null;
    return { method, pat };
  }

  async setToken(token: string | null): Promise<void> {
    if (token) await this.secrets.set(GITHUB_PAT_SECRET, token);
    else await this.secrets.delete(GITHUB_PAT_SECRET);
  }
}
