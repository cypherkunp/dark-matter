import { posix } from "node:path";
import {
  type ClientKind,
  type ImportCandidate,
  type ImportResult,
  ImportSkillNotFound,
  type LibraryLockEntry,
  type SkillsShListing,
  type SkillsShSearch,
  SourceUnreachable,
} from "@dark-matter/contracts";
import { z } from "zod";
import type { Clock } from "./clock";
import { describeFetchError } from "./fetch-error";
import { type Importer, installedName } from "./importer";
import type { Library } from "./library";

/** Where the core reaches skills.sh. Tests and e2e pass a fake's base URL. */
export interface SkillsShOptions {
  /** Default: https://skills.sh. */
  api?: string;
}

/** The core's skills.sh options from its environment: `DARK_MATTER_SKILLS_SH_API` points it at a fake. */
export const skillsShOptionsFrom = (env: { DARK_MATTER_SKILLS_SH_API?: string | undefined }): SkillsShOptions =>
  env.DARK_MATTER_SKILLS_SH_API ? { api: env.DARK_MATTER_SKILLS_SH_API } : {};

const SKILLS_SH = "https://skills.sh";
/** skills.sh's public `/api/search` allows 30 requests a minute per IP (#4), then answers 429 with Retry-After: 60. */
export const SEARCHES_PER_MINUTE = 30;
const MINUTE = 60_000;
/** skills.sh's terms encourage caching; its own server caches search for 30-60 s. */
const CACHE_FOR = 5 * MINUTE;
const RESULTS = 50;

const SearchResponse = z.object({
  skills: z.array(
    z.object({
      id: z.string().optional(),
      source: z.string(),
      skillId: z.string(),
      name: z.string().optional(),
      installs: z.number().optional(),
    }),
  ),
});
type Listing = Omit<SkillsShListing, "key">;
type Fetched = { listings: Listing[] } | { until: number };

export interface SkillsShServiceOptions {
  api?: string;
  clock: Clock;
  library: Library;
  importer: Importer;
}

/**
 * skills.sh search and Get (#31). Search is rate limited here, in the core,
 * so every window and screen shares one budget of 30 requests a minute;
 * results are cached per query, so a Library change re-marks "in Library"
 * without asking skills.sh again. Get resolves a listing to its repo and
 * Skill folder and Imports it with GitHub Import (#30).
 */
export class SkillsSh {
  readonly #api: string;
  readonly #options: SkillsShServiceOptions;
  /** When each request in the last minute was sent. */
  #sent: number[] = [];
  /** A 429's Retry-After. */
  #blockedUntil = 0;
  readonly #cache = new Map<string, { at: number; listings: Listing[] }>();
  readonly #inFlight = new Map<string, Promise<Fetched>>();

  constructor(options: SkillsShServiceOptions) {
    this.#options = options;
    this.#api = (options.api ?? SKILLS_SH).replace(/\/+$/, "");
  }

  async search(raw: string): Promise<SkillsShSearch> {
    const query = raw.trim().replace(/\s+/g, " ");
    // skills.sh refuses queries under 2 characters.
    if (query.length < 2) return { query, skills: [], rateLimitedUntil: null };
    const cacheKey = query.toLowerCase();
    const now = this.#options.clock.now().getTime();
    const cached = this.#cache.get(cacheKey);
    if (cached && now - cached.at < CACHE_FOR) return this.#result(query, cached.listings);
    let pending = this.#inFlight.get(cacheKey);
    if (!pending) {
      pending = this.#fetch(query, now).finally(() => this.#inFlight.delete(cacheKey));
      this.#inFlight.set(cacheKey, pending);
    }
    const fetched = await pending;
    if ("until" in fetched) return { query, skills: [], rateLimitedUntil: new Date(fetched.until).toISOString() };
    this.#cache.set(cacheKey, { at: now, listings: fetched.listings });
    return this.#result(query, fetched.listings);
  }

  async #fetch(query: string, now: number): Promise<Fetched> {
    this.#sent = this.#sent.filter((at) => now - at < MINUTE);
    if (this.#blockedUntil > now) return { until: this.#blockedUntil };
    const oldest = this.#sent[0];
    if (this.#sent.length >= SEARCHES_PER_MINUTE && oldest !== undefined) return { until: oldest + MINUTE };
    this.#sent.push(now);
    const url = `${this.#api}/api/search?${new URLSearchParams({ q: query, limit: String(RESULTS) })}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "dark-matter" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new SourceUnreachable("skills.sh", describeFetchError(error));
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      this.#blockedUntil = now + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : MINUTE);
      return { until: this.#blockedUntil };
    }
    if (!response.ok) throw new SourceUnreachable("skills.sh", `search answered HTTP ${response.status}`);
    const body = SearchResponse.safeParse(await response.json().catch(() => null));
    if (!body.success) throw new SourceUnreachable("skills.sh", "search answered in an unknown shape");
    return {
      listings: body.data.skills.map((skill) => {
        const id = skill.id ?? `${skill.source}/${skill.skillId}`;
        return {
          id,
          source: skill.source,
          slug: skill.skillId,
          name: skill.name ?? skill.skillId,
          installs: skill.installs ?? 0,
          url: `https://skills.sh/${id}`,
        };
      }),
    };
  }

  #result(query: string, listings: Listing[]): SkillsShSearch {
    const entries = Object.entries(this.#options.library.lock.value.skills);
    return {
      query,
      rateLimitedUntil: null,
      skills: listings.map((listing) => ({ ...listing, key: libraryKeyOf(entries, listing.source, listing.slug) })),
    };
  }

  /** Get: Imports the listing's Skill from its GitHub repo at the default branch's head. */
  get(id: string, client: ClientKind): Promise<ImportResult> {
    const [owner, repo, ...rest] = id.split("/");
    const slug = rest.join("/");
    const fullName = `${owner}/${repo}`;
    return this.#options.importer.importFrom(
      { fullName, ref: null, subpath: null, skill: slug },
      undefined,
      client,
      (fetched) => [pickListed(fetched.candidates, fetched.fullName, slug)],
    );
  }
}

/** The repo's Skill a listing's slug names: by installed name, else by folder name. */
const pickListed = (candidates: ImportCandidate[], fullName: string, slug: string): ImportCandidate => {
  const wanted = installedName(slug);
  const found =
    candidates.find((candidate) => installedName(candidate.name) === wanted) ??
    candidates.find((candidate) => installedName(posix.basename(candidate.path)) === wanted);
  if (!found) throw new ImportSkillNotFound(fullName, slug);
  return found;
};

/** The Library key holding a listing: same GitHub Source, and its key or Skill folder carries the slug. */
const libraryKeyOf = (entries: [string, LibraryLockEntry][], source: string, slug: string): string | null => {
  const wanted = installedName(slug);
  const match = entries.find(
    ([key, entry]) =>
      entry.sourceType === "github" &&
      entry.source.toLowerCase() === source.toLowerCase() &&
      (installedName(key.slice(key.lastIndexOf("/") + 1)) === wanted ||
        (!!entry.skillPath && installedName(posix.basename(posix.dirname(entry.skillPath))) === wanted)),
  );
  return match?.[0] ?? null;
};
