import type { DatabaseSync } from "node:sqlite";
import type { GitHubCheckStatus, SourceCheckStatus } from "@dark-matter/contracts";
import type { Clock } from "./clock";
import type { GitHubSession, GitHubTreeEntry } from "./github";

/** A GitHub Source and the ref it follows. */
export interface SourceRef {
  /** `owner/repo`. */
  source: string;
  ref: string;
}

/** A Source's folders at one commit: tree SHAs by repo path (`.` = the root) and the folders holding a SKILL.md. */
export interface SourceFolders {
  commit: string;
  folders: Map<string, string>;
  /** Folders with a SKILL.md: where the Skills are (#35 finds new ones in a starred Source here). */
  skillFolders: string[];
}

const posixDirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");

/** Folder tree SHAs and Skill folders from a recursive Trees listing. */
export const sourceFolders = (commit: string, rootSha: string, entries: readonly GitHubTreeEntry[]): SourceFolders => ({
  commit,
  folders: new Map([
    [".", rootSha],
    ...entries.filter((entry) => entry.type === "tree").map((entry) => [entry.path, entry.sha] as const),
  ]),
  skillFolders: entries
    .filter((entry) => entry.type === "blob" && (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")))
    .map((entry) => posixDirname(entry.path))
    .sort(),
});

/**
 * The per-Source half of the update check (#11 point 6), shared by Updates
 * (#33) and starred Sources (#35). `head` is one call for the tracked ref's
 * head; `folders` is one Trees call per new commit. Last head seen, the
 * folders per commit, rate limit and auth status live in SQLite only
 * (ADR-0005): losing them costs a Trees call, never a decision.
 */
export class SourceChecks {
  constructor(
    private readonly cache: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  /** The tracked ref's head (one call); records it as the last head seen. */
  async head(session: GitHubSession, { source, ref }: SourceRef): Promise<string> {
    try {
      const { sha } = await session.commit(source, ref);
      this.#saveStatus({ source, ref, head: sha, checkedAt: this.clock.now().toISOString(), error: null });
      return sha;
    } catch (error) {
      this.#saveStatus({
        source,
        ref,
        head: null,
        checkedAt: this.clock.now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.noteGitHub(session);
    }
  }

  /** The Source's folders at `commit` (one Trees call, cached by commit). */
  async folders(session: GitHubSession, { source, ref }: SourceRef, commit: string): Promise<SourceFolders> {
    const row = this.cache.prepare("SELECT folders FROM source_checks WHERE source = ? AND ref = ?").get(source, ref) as
      | { folders: string | null }
      | undefined;
    const cached = row?.folders ? (JSON.parse(row.folders) as Record<string, CachedFolders>) : {};
    const hit = cached[commit];
    if (hit) return { commit, folders: new Map(Object.entries(hit.folders)), skillFolders: hit.skillFolders };
    try {
      const tree = await session.tree(source, commit);
      const found = sourceFolders(commit, tree.sha, tree.entries);
      // Keep the newest few commits: the head and the Library's pinned ones.
      const next = Object.fromEntries(
        [
          ...Object.entries(cached).slice(-3),
          [commit, { folders: Object.fromEntries(found.folders), skillFolders: found.skillFolders }] as const,
        ].slice(-4),
      );
      this.cache
        .prepare(
          `INSERT INTO source_checks (source, ref, status, folders) VALUES (?, ?, 'null', ?)
           ON CONFLICT (source, ref) DO UPDATE SET folders = excluded.folders`,
        )
        .run(source, ref, JSON.stringify(next));
      return found;
    } finally {
      this.noteGitHub(session);
    }
  }

  /** Head and folders in one go: what #35 needs to list a starred Source's Skills. */
  async snapshot(session: GitHubSession, source: SourceRef): Promise<SourceFolders> {
    return this.folders(session, source, await this.head(session, source));
  }

  /** Every Source's last check. */
  statuses(): SourceCheckStatus[] {
    return (this.cache.prepare("SELECT status FROM source_checks ORDER BY source, ref").all() as { status: string }[])
      .map((row) => JSON.parse(row.status) as SourceCheckStatus | null)
      .filter((status): status is SourceCheckStatus => status !== null);
  }

  status({ source, ref }: SourceRef): SourceCheckStatus | null {
    const row = this.cache.prepare("SELECT status FROM source_checks WHERE source = ? AND ref = ?").get(source, ref) as
      | { status: string }
      | undefined;
    return row ? (JSON.parse(row.status) as SourceCheckStatus | null) : null;
  }

  /** Auth and rate limit as GitHub last reported them. */
  github(): GitHubCheckStatus | null {
    const row = this.cache.prepare("SELECT status FROM github_status WHERE id = 1").get() as
      | { status: string }
      | undefined;
    return row ? (JSON.parse(row.status) as GitHubCheckStatus) : null;
  }

  noteGitHub(session: GitHubSession) {
    const status: GitHubCheckStatus = {
      auth: session.auth,
      rateLimit: session.rateLimit,
      checkedAt: this.clock.now().toISOString(),
    };
    this.cache
      .prepare(
        "INSERT INTO github_status (id, status) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status",
      )
      .run(JSON.stringify(status));
  }

  #saveStatus(status: SourceCheckStatus) {
    this.cache
      .prepare(
        `INSERT INTO source_checks (source, ref, status) VALUES (?, ?, ?)
         ON CONFLICT (source, ref) DO UPDATE SET status = excluded.status`,
      )
      .run(status.source, status.ref, JSON.stringify(status));
  }
}

interface CachedFolders {
  folders: Record<string, string>;
  skillFolders: string[];
}
