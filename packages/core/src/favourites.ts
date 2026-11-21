import { posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type ActivityClient,
  type Favourites as FavouritesList,
  type FavouritesView,
  type InboxNewSkillsGroup,
  InvalidOwnedFile,
  type LibraryLockEntry,
  type LibrarySkill,
  type NewSkillFinding,
  RateLimited,
  type SettingsFile,
  SkillNotFound,
  type StarSkillInput,
  type StarSourceInput,
} from "@dark-matter/contracts";
import type { ActivityLog } from "./activity";
import type { Clock } from "./clock";
import { GitHubNotFound, type GitHubSession } from "./github";
import { homeRelative } from "./home-path";
import type { Library } from "./library";
import type { KeyRename, KeyRenameHook } from "./namespace-rename";
import type { Notifier } from "./notifier";
import type { OwnedFile } from "./owned-file";
import type { SourceChecks } from "./source-check";

export interface FavouritesOptions {
  settings: OwnedFile<typeof SettingsFile>;
  library: Library;
  activity: ActivityLog;
  checks: SourceChecks;
  cache: DatabaseSync;
  clock: Clock;
  /** Every Library Skill, with Project usage. */
  librarySkills: () => Promise<LibrarySkill[]>;
  onChange: () => void;
}

/** The starred-Source half of the update check, run by Updates (#33) alongside its own per-Source check. */
export interface StarredSourceCheck {
  /** Starred Sources (`owner/repo`). */
  sources(): string[];
  /**
   * Looks for Skills each starred Source gained (`only`: just these Sources,
   * lowercased). `heads` are heads Updates already fetched, by
   * `owner/repo@ref` (Source lowercased), so a Source costs one head call per check.
   * Returns the first failure, or null.
   */
  check(session: GitHubSession, heads: ReadonlyMap<string, string>, only: ReadonlySet<string> | null): Promise<unknown>;
  /** Ids of findings waiting now: the daily run compares before and after to notify. */
  waiting(): Set<string>;
  notifyNew(before: ReadonlySet<string>, notifier: Notifier): void;
}

const lower = (source: string) => source.toLowerCase();
const findingId = (source: string, path: string) => `new-skill:${source}:${path}`;
const folderOf = (entry: LibraryLockEntry) => (entry.skillPath ? posix.dirname(entry.skillPath) : ".");
const fromSource = (entry: LibraryLockEntry): string | null =>
  entry.sourceType === "github" && !entry.localSource ? entry.source : null;
const tracksBranch = (entry: LibraryLockEntry) =>
  !!entry.ref && entry.refType !== "tag" && !/^[0-9a-f]{40}$/.test(entry.ref);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS starred_sources (
    source TEXT PRIMARY KEY,
    known TEXT NOT NULL,
    found TEXT NOT NULL,
    checked_at TEXT NOT NULL
  );
`;

interface StarredRow {
  /** Skill folders seen at the last check. */
  known: string[];
  /** Folders that appeared after the first check, and when. */
  found: Record<string, string>;
  checkedAt: string;
}

/**
 * Favourites (#35, decided in #15 and #18): stars on Library Skills and on
 * Sources, kept in `settings.json`. A starred Source surfaces the Skills it
 * gains as "New Skills in ⭐ owner/repo" in the Inbox; nothing is ever
 * Imported on its own. What a Source had at its last check lives in the
 * cache: losing it costs one check's news, never a decision (ADR-0005).
 */
export class Favourites {
  readonly #options: FavouritesOptions;

  constructor(options: FavouritesOptions) {
    this.#options = options;
    options.cache.exec(SCHEMA);
  }

  get(): FavouritesList {
    const { favourites } = this.#options.settings.value;
    return { skills: favourites?.skills ?? [], sources: favourites?.sources ?? [] };
  }

  setSkill({ key, starred }: StarSkillInput, client: ActivityClient): Promise<FavouritesList> {
    const { activity, library } = this.#options;
    return activity.track(
      { client, action: "favourites.setSkill", subjects: [{ kind: "skill", id: key }] },
      async (wrote) => {
        if (starred && !library.lock.value.skills[key]) throw new SkillNotFound(key);
        wrote(
          await this.#save(({ skills, sources }) => ({
            skills: starred ? [...new Set([...skills, key])] : skills.filter((starredKey) => starredKey !== key),
            sources,
          })),
        );
        return this.get();
      },
    );
  }

  setSource({ source, starred }: StarSourceInput, client: ActivityClient): Promise<FavouritesList> {
    return this.#options.activity.track(
      { client, action: "favourites.setSource", subjects: [{ kind: "source", id: source }] },
      async (wrote) => {
        wrote(
          await this.#save(({ skills, sources }) => {
            const others = sources.filter((starredSource) => lower(starredSource) !== lower(source));
            const kept = sources.find((starredSource) => lower(starredSource) === lower(source));
            return { skills, sources: starred ? [...others, kept ?? source] : others };
          }),
        );
        return this.get();
      },
    );
  }

  async #save(edit: (current: FavouritesList) => FavouritesList): Promise<string | null> {
    const { settings } = this.#options;
    if (settings.problem) throw new InvalidOwnedFile(settings.problem.path, settings.problem.message);
    const path = await settings.update((current) => {
      const next = edit({ skills: current.favourites?.skills ?? [], sources: current.favourites?.sources ?? [] });
      const sorted = { skills: [...next.skills].sort(), sources: [...next.sources].sort() };
      return { ...current, favourites: sorted };
    });
    this.#options.onChange();
    return path;
  }

  /** Starred Skills plus every Library Skill from a starred Source. */
  async view(): Promise<FavouritesView> {
    const { library } = this.#options;
    const { skills: starredKeys, sources } = this.get();
    const starredSources = new Set(sources.map(lower));
    const starred = new Set(starredKeys);
    const entries = library.lock.value.skills;
    const all = await this.#options.librarySkills();
    const skills = all.filter((skill) => {
      const entry = entries[skill.key];
      const source = entry ? fromSource(entry) : null;
      return starred.has(skill.key) || (source !== null && starredSources.has(lower(source)));
    });
    const waiting = this.#groups();
    return {
      skills,
      sources: sources.map((source) => ({
        source,
        skills: Object.values(entries).filter((entry) => lower(fromSource(entry) ?? "") === lower(source)).length,
        newSkills: waiting.find((group) => lower(group.source) === lower(source))?.findings.length ?? 0,
        checkedAt: this.#row(source)?.checkedAt ?? null,
      })),
    };
  }

  /** Every new-Skill finding in starred Sources, ignored ones included (the Inbox leaves those out). */
  inboxGroups(): InboxNewSkillsGroup[] {
    const entries = Object.values(this.#options.library.lock.value.skills);
    return this.get().sources.flatMap((source) => {
      const row = this.#row(source);
      if (!row) return [];
      const inLibrary = new Set(
        entries.filter((entry) => lower(fromSource(entry) ?? "") === lower(source)).map(folderOf),
      );
      const findings: NewSkillFinding[] = Object.entries(row.found)
        .filter(([path]) => !inLibrary.has(path))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, foundAt]) => ({
          id: findingId(source, path),
          source,
          path,
          name: path === "." ? (source.split("/")[1] ?? source) : posix.basename(path),
          foundAt,
        }));
      return findings.length > 0 ? [{ source, findings }] : [];
    });
  }

  /** Waiting findings, minus ignored ones. */
  #groups(): InboxNewSkillsGroup[] {
    const ignored = new Set(this.#options.settings.value.ignoredFindings);
    return this.inboxGroups()
      .map((group) => ({ ...group, findings: group.findings.filter((finding) => !ignored.has(finding.id)) }))
      .filter((group) => group.findings.length > 0);
  }

  #row(source: string): StarredRow | null {
    const row = this.#options.cache
      .prepare("SELECT known, found, checked_at FROM starred_sources WHERE source = ?")
      .get(lower(source)) as { known: string; found: string; checked_at: string } | undefined;
    return row ? { known: JSON.parse(row.known), found: JSON.parse(row.found), checkedAt: row.checked_at } : null;
  }

  /** The branch a starred Source is followed on: its Library Skills' branch, else the repo's default. */
  async #ref(session: GitHubSession, source: string): Promise<string> {
    const entry = Object.values(this.#options.library.lock.value.skills).find(
      (candidate) => lower(fromSource(candidate) ?? "") === lower(source) && tracksBranch(candidate),
    );
    return entry?.ref ?? (await session.repo(source)).defaultBranch;
  }

  #check = async (session: GitHubSession, source: string, heads: ReadonlyMap<string, string>) => {
    const { checks, cache, clock } = this.#options;
    const ref = await this.#ref(session, source);
    const head = heads.get(`${lower(source)}@${ref}`) ?? (await checks.head(session, { source, ref }));
    const { skillFolders } = await checks.folders(session, { source, ref }, head);
    const now = clock.now().toISOString();
    const previous = this.#row(source);
    const found: Record<string, string> = {};
    if (previous) {
      const known = new Set(previous.known);
      for (const path of skillFolders) {
        const since = previous.found[path] ?? (known.has(path) ? undefined : now);
        if (since) found[path] = since;
      }
    }
    cache
      .prepare(
        `INSERT INTO starred_sources (source, known, found, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (source) DO UPDATE SET known = excluded.known, found = excluded.found, checked_at = excluded.checked_at`,
      )
      .run(lower(source), JSON.stringify(skillFolders), JSON.stringify(found), now);
  };

  starredSourceCheck(): StarredSourceCheck {
    return {
      sources: () => this.get().sources,
      check: async (session, heads, only) => {
        let failure: unknown = null;
        for (const source of this.get().sources) {
          if (only && !only.has(lower(source))) continue;
          try {
            await this.#check(session, source, heads);
          } catch (error) {
            // A Source that's gone has nothing new to show.
            if (error instanceof GitHubNotFound) continue;
            failure ??= error;
            if (error instanceof RateLimited) break;
          }
        }
        this.#options.onChange();
        return failure;
      },
      waiting: () => new Set(this.#groups().flatMap((group) => group.findings.map((finding) => finding.id))),
      notifyNew: (before, notifier) => {
        for (const group of this.#groups()) {
          const fresh = group.findings.filter((finding) => !before.has(finding.id));
          if (fresh.length === 0) continue;
          notifier.notify({
            title: `New Skills in ⭐ ${group.source}`,
            body: fresh.map((finding) => finding.name).join(", "),
            path: "/inbox",
          });
        }
      },
    };
  }

  /** Starred Skills follow a Namespace rename or a Detach. */
  keyRenameHook(home: string): KeyRenameHook {
    const { settings } = this.#options;
    const path = homeRelative(home, settings.path);
    const change = "re-key starred Skills";
    const starred = (renames: KeyRename[]) =>
      this.get().skills.some((key) => renames.some((rename) => rename.from === key));
    return {
      steps: async (renames) => (starred(renames) ? [{ kind: "editFile", path, change }] : []),
      editFile: async (step, renames) => {
        if (step.path !== path || step.change !== change) return null;
        const rekey = (key: string) => renames.find((rename) => rename.from === key)?.to ?? key;
        const written = await this.#save(({ skills, sources }) => ({ skills: skills.map(rekey), sources }));
        return written ? [written] : [];
      },
    };
  }
}
