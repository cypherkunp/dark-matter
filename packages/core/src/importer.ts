import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  type ClientKind,
  type Domain,
  type ImportCandidate,
  type ImportPreview,
  type ImportResult,
  ImportSkillNotFound,
  type ImportSkillsInput,
  InvalidOwnedFile,
  type LibraryLockEntry,
  NotInLibrary,
  type PlanStep,
  SourceUnreachable,
} from "@dark-matter/contracts";
import type { CoreServices } from "@dark-matter/contracts/router";
import { installSkills, isDiagnostic, resolveSource, type SkillSource } from "skills";
import type { ActivityLog } from "./activity";
import { GITHUB_PAT_SECRET, type GitHubAccess, type GitHubSession } from "./github";
import { homeRelative } from "./home-path";
import { type ImportSource, parseImportSource } from "./import-source";
import type { Library } from "./library";
import { applySteps } from "./plan";
import type { LockImporter } from "./repo-skills";
import { computeSkillFolderHash } from "./skill-hash";
import { WriteQueue } from "./write-queue";

/** The folder name the `skills` package installs a Skill under (its `sanitizeName`), so keys match `npx skills add`. */
export const installedName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .substring(0, 255) || "unnamed-skill";

/**
 * The update check for one Library Skill (#11): updated only when its own
 * folder changed. `headFolderSha` is its folder's tree SHA at the tracked
 * ref's head (undefined = the path is gone upstream, which #33 marks Orphaned).
 */
export const updateAvailable = (entry: LibraryLockEntry | undefined, headFolderSha: string | undefined): boolean =>
  !!entry && !!headFolderSha && entry.skillFolderHash !== headFolderSha;

/**
 * Copies picked Skills out of a fetched Source the way `npx skills add` does
 * (into the staging folder beside the checkout). Returns their folders by repo path.
 */
export const installFetched = async (
  fetched: FetchedSource,
  candidates: readonly ImportCandidate[],
): Promise<Map<string, string>> => {
  if (!fetched.found) throw new ImportSkillNotFound(fetched.fullName, candidates[0]?.path ?? ".");
  const result = await installSkills(fetched.found, {
    cwd: join(fetched.checkout, "..", "out"),
    skills: candidates.map((candidate) => candidate.name),
    agents: ["universal"],
    mode: "copy",
    scope: "project",
    lockfile: false,
    telemetry: false,
    symlinks: "reject",
  });
  const failure = result.failed[0];
  if (failure) throw new Error(`${failure.skill}: ${failure.message}`);
  return new Map(
    candidates.map((candidate) => {
      const installed = result.installed.find((target) => target.skill === candidate.name);
      if (!installed) throw new Error(`${candidate.name} wasn't fetched`);
      return [candidate.path, installed.path] as const;
    }),
  );
};

/** A skills-lock v2 `skillPath`: the SKILL.md inside the repo. */
export const skillPathOf = (folder: string) => (folder === "." ? "SKILL.md" : `${folder}/SKILL.md`);

/** A Source's commit, downloaded into `staging/` and searched by the `skills` package. Dispose it when done. */
export interface FetchedSource {
  fullName: string;
  ref: string;
  /** A tag only moves when re-pointed (#33). */
  refType: "branch" | "tag" | "commit";
  commit: string;
  subpath: string | null;
  /** The repo checkout under `staging/`. */
  checkout: string;
  found: SkillSource | null;
  /** The picker rows, by repo path. */
  candidates: ImportCandidate[];
  dispose(): Promise<void>;
}

export interface ImporterOptions {
  /** The core's one write queue (review #8); a queue of its own when left out (tests). */
  writes?: WriteQueue;
  home: string;
  libraryHome: string;
  library: Library;
  github: GitHubAccess;
  activity: ActivityLog;
  onChange: (domains: Domain[]) => void;
}

/**
 * GitHub Import (#30, decided in #11). A Source is `owner/repo` plus a tracked
 * ref; it isn't stored on its own but derived from the Library Lock entries
 * that name it. Fetching downloads the pinned commit's tarball into
 * `staging/`; the `skills` package finds the Skills there exactly as
 * `npx skills add` would, and copies the picked ones out for the Library.
 */
export class Importer {
  readonly #options: ImporterOptions;
  readonly #ownWrites = new WriteQueue();

  constructor(options: ImporterOptions) {
    this.#options = options;
  }

  get options(): ImporterOptions {
    return this.#options;
  }

  /**
   * Imports the picked Skills at exactly the previewed commit. A Skill already
   * Imported from the same Source and path isn't duplicated: it gets an update
   * check (its folder's tree SHA at the tracked ref's head) and is left as is.
   */
  import({ input, commit, paths }: ImportSkillsInput, client: ClientKind): Promise<ImportResult> {
    return this.importFrom(parseImportSource(input), commit, client, (fetched) =>
      [...new Set(paths)].map((path) => {
        const candidate = fetched.candidates.find((found) => found.path === path);
        if (!candidate) throw new ImportSkillNotFound(fetched.fullName, path);
        return candidate;
      }),
    );
  }

  /**
   * #28's hook: fulfilling a Project's `skills-lock.json` entry that isn't in
   * the Library Imports it first, at the entry's own commit (so the Copy
   * matches what the team pinned) and following its ref.
   */
  lockImporter(): LockImporter {
    return {
      importEntry: async (name, entry) => {
        const source = entry.sourceType === undefined || entry.sourceType === "github" ? entry.source : null;
        const parsed = source ? parseImportSource(source) : null;
        if (!parsed) throw new NotInLibrary(name, entry.source);
        const folder = entry.skillPath ? posix.dirname(entry.skillPath) : null;
        const commit = entry.commit && /^[0-9a-f]{40}$/.test(entry.commit) ? entry.commit : undefined;
        const result = await this.importFrom({ ...parsed, ref: entry.ref ?? null }, commit, "app", (fetched) => {
          const candidate =
            fetched.candidates.find((found) => folder !== null && found.path === folder) ??
            fetched.candidates.find((found) => installedName(found.name) === name);
          if (!candidate) throw new ImportSkillNotFound(fetched.fullName, folder ?? name);
          return [candidate];
        });
        const key = result.skills[0]?.key;
        if (!key) throw new NotInLibrary(name, entry.source);
        return key;
      },
    };
  }

  /** Fetches `source` (at `commit`, else its tracked ref's head), then Imports what `pick` chooses from it. */
  importFrom(
    source: ImportSource,
    commit: string | undefined,
    client: ClientKind,
    pick: (fetched: FetchedSource) => ImportCandidate[],
  ): Promise<ImportResult> {
    return this.#serial(async () => {
      const { home, library, activity } = this.#options;
      const session = await this.#options.github.session();
      const fetched = await this.fetch(session, source, commit);
      try {
        const picked = pick(fetched);
        const fresh = picked.filter((candidate) => !candidate.inLibrary);
        const folders = await this.#folderShas(session, fetched);
        const head =
          fresh.length < picked.length
            ? await this.#headFolderShas(session, fetched, folders)
            : new Map<string, string>();
        return await activity.track(
          {
            client,
            action: "importer.import",
            subjects: [
              { kind: "source", id: fetched.fullName },
              ...picked.map((candidate) => ({ kind: "skill" as const, id: candidate.key })),
            ],
          },
          async (wrote) => {
            const entries: Record<string, LibraryLockEntry> = {};
            const steps: PlanStep[] = [];
            if (fresh.length > 0 && fetched.found) {
              const installed = await installFetched(fetched, fresh);
              for (const candidate of fresh) {
                const path = installed.get(candidate.path) ?? "";
                const computedHash = await computeSkillFolderHash(path);
                const skillFolderHash = folders.get(candidate.path);
                entries[candidate.key] = {
                  source: fetched.fullName,
                  sourceType: "github",
                  ref: fetched.ref,
                  commit: fetched.commit,
                  skillPath: skillPathOf(candidate.path),
                  computedHash,
                  ...(skillFolderHash ? { skillFolderHash } : {}),
                  ...(fetched.refType === "tag" && { refType: "tag" as const }),
                };
                steps.push({
                  kind: "move",
                  from: homeRelative(home, path),
                  to: homeRelative(home, library.folder(candidate.key)),
                });
              }
              steps.push({
                kind: "editFile",
                path: homeRelative(home, library.lock.path),
                change: `add ${fresh.map((candidate) => candidate.key).join(", ")}`,
              });
              if (library.lock.problem) throw new InvalidOwnedFile(library.lock.path, library.lock.problem.message);
              await applySteps(steps, {
                home,
                libraryHome: library.libraryHome,
                wrote,
                editFile: async () => {
                  const path = await library.lock.update((current) => ({
                    ...current,
                    skills: { ...current.skills, ...entries },
                  }));
                  return path ? [path] : [];
                },
              });
              this.#options.onChange(["library", "skill", "inbox"]);
            }
            return {
              source: fetched.fullName,
              ref: fetched.ref,
              commit: fetched.commit,
              skills: picked.map((candidate) => ({
                key: candidate.key,
                path: candidate.path,
                outcome: !candidate.inLibrary
                  ? ("imported" as const)
                  : updateAvailable(library.lock.value.skills[candidate.key], head.get(candidate.path))
                    ? ("updateAvailable" as const)
                    : ("upToDate" as const),
              })),
            };
          },
        );
      } finally {
        await fetched.dispose();
      }
    });
  }

  /** Tree SHAs of every folder at the fetched commit, by repo path (`.` = the root). One Trees API call. */
  async #folderShas(session: GitHubSession, fetched: FetchedSource): Promise<Map<string, string>> {
    const tree = await session.tree(fetched.fullName, fetched.commit);
    return new Map([
      [".", tree.sha],
      ...tree.entries.filter((entry) => entry.type === "tree").map((entry) => [entry.path, entry.sha] as const),
    ]);
  }

  /** Folder tree SHAs at the tracked ref's head: the update check (#11). Unmoved head = the fetched commit's. */
  async #headFolderShas(
    session: GitHubSession,
    fetched: FetchedSource,
    atCommit: Map<string, string>,
  ): Promise<Map<string, string>> {
    const head = await session.commit(fetched.fullName, fetched.ref);
    if (head.sha === fetched.commit) return atCommit;
    return this.#folderShas(session, { ...fetched, commit: head.sha });
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    return (this.#options.writes ?? this.#ownWrites).run(task);
  }

  async preview(input: string): Promise<ImportPreview> {
    const session = await this.#options.github.session();
    const fetched = await this.fetch(session, parseImportSource(input));
    try {
      return {
        source: fetched.fullName,
        ref: fetched.ref,
        commit: fetched.commit,
        subpath: fetched.subpath,
        auth: session.auth,
        skills: fetched.candidates,
      };
    } finally {
      await fetched.dispose();
    }
  }

  /**
   * Downloads `commit` (default: the tracked ref's head) into `staging/` and
   * finds its Skills. #31 (skills.sh Get) and re-pointing reuse this.
   */
  async fetch(session: GitHubSession, input: ImportSource, commit?: string): Promise<FetchedSource> {
    const repo = await session.repo(input.fullName);
    const resolved = input.treePath
      ? await session.resolveTreeRef(repo.fullName, input.treePath)
      : input.ref && input.refType
        ? { ref: input.ref, refType: input.refType, subpath: input.subpath }
        : input.ref
          ? await session.resolveTreeRef(repo.fullName, input.ref)
          : null;
    const source = { ...input, subpath: input.treePath ? (resolved?.subpath ?? null) : input.subpath };
    const ref = resolved?.ref ?? repo.defaultBranch;
    const refType = resolved?.refType ?? "branch";
    const sha = commit ?? (await session.commit(repo.fullName, ref)).sha;
    const staging = join(this.#options.libraryHome, "staging", randomUUID());
    const dispose = async () => {
      await found?.dispose();
      await rm(staging, { recursive: true, force: true });
    };
    let found: SkillSource | null = null;
    try {
      const checkout = join(staging, "source");
      await session.download(repo.fullName, sha, checkout);
      const root = source.subpath ? join(checkout, ...source.subpath.split("/")) : checkout;
      if (!(await stat(root).catch(() => null))?.isDirectory()) {
        throw new SourceUnreachable(`${repo.fullName}/${source.subpath}`, `no such folder at ${ref}`);
      }
      found = await resolveSource(root, { cwd: staging, config: { telemetry: false } }).catch((error: unknown) => {
        if (isDiagnostic(error, "SKILLS_NO_VALID_SKILLS")) return null;
        throw error;
      });
      const skills = found?.skills ?? [];
      const candidates = await Promise.all(
        skills.map(async (skill): Promise<ImportCandidate> => {
          const path = posix.join(source.subpath ?? ".", skill.path ?? ".");
          const skillMd = await readFile(join(checkout, path, "SKILL.md"), "utf8").catch(() => "");
          const existing = this.#existingKey(repo.fullName, path);
          return {
            name: skill.name,
            description: skill.description,
            path,
            skillMd,
            selected:
              skills.length === 1 ||
              (source.skill !== null && installedName(skill.name) === installedName(source.skill)),
            key: existing ?? this.#newKey(repo.fullName, skill.name, path),
            inLibrary: existing !== null,
          };
        }),
      );
      return {
        fullName: repo.fullName,
        ref,
        refType,
        commit: sha,
        subpath: source.subpath,
        checkout,
        found,
        candidates,
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  /** The Library key already Imported from this Source and path. */
  #existingKey(fullName: string, path: string): string | null {
    const skillPath = skillPathOf(path);
    const match = Object.entries(this.#options.library.lock.value.skills).find(
      ([, entry]: [string, LibraryLockEntry]) =>
        entry.sourceType === "github" &&
        entry.source.toLowerCase() === fullName.toLowerCase() &&
        entry.skillPath === skillPath,
    );
    return match?.[0] ?? null;
  }

  /** `<owner>/<repo>/<name>`, or with a short hash of the path when another Skill already holds that key. */
  #newKey(fullName: string, name: string, path: string): string {
    const key = `${fullName}/${installedName(name)}`;
    if (!(key in this.#options.library.lock.value.skills)) return key;
    return `${key}-${createHash("sha256").update(path).digest("hex").slice(0, 7)}`;
  }
}

/** The `importer` RPC domain. */
export const importerServices = (
  importer: Importer,
): Pick<CoreServices["importer"], "preview" | "import" | "auth" | "setToken"> => {
  const { github, activity } = importer.options;
  return {
    preview: ({ input }) => importer.preview(input),
    import: (input, client) => importer.import(input, client),
    auth: () => github.status(),
    setToken: ({ token }, client) =>
      activity.track(
        {
          client,
          action: token ? "importer.setToken" : "importer.removeToken",
          subjects: [{ kind: "settings", id: GITHUB_PAT_SECRET }],
        },
        async () => {
          await github.setToken(token);
          importer.options.onChange(["importer"]);
          return github.status();
        },
      ),
  };
};
