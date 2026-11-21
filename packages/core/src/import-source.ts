import { InvalidImportSource } from "@dark-matter/contracts";

/** What an Import was pointed at, before GitHub is asked anything. */
export interface ImportSource {
  /** `owner/repo` as pasted; GitHub's own spelling replaces it once the repo is looked up. */
  fullName: string;
  /** The branch or tag from a tree URL; null means the default branch. */
  ref: string | null;
  /** The folder a tree URL limits the search to. */
  subpath: string | null;
  /** The Skill a skills.sh listing URL names (its slug), ticked in the picker. */
  skill: string | null;
  /**
   * A tree URL's whole `<ref>/<path>`. Branch names may contain `/`, so `ref`
   * and `subpath` above are only a first guess (first segment, rest) until the
   * Importer asks GitHub where the ref really ends.
   */
  treePath?: string;
  /** Set when the ref is already known (an update follows a Library Lock entry), so GitHub isn't asked again. */
  refType?: "branch" | "tag" | "commit";
}

const NAME = "[A-Za-z0-9_.-]+";
const SHORTHAND = new RegExp(`^(${NAME})/(${NAME})$`);
const GITHUB_URL = new RegExp(
  `^(?:https?://)?(?:www\\.)?github\\.com/(${NAME})/(${NAME}?)(?:\\.git)?(?:/tree/([^/]+)(?:/(.+?))?)?/?$`,
  "i",
);
const SKILLS_SH_URL = new RegExp(`^(?:https?://)?(?:www\\.)?skills\\.sh/(${NAME})/(${NAME})(?:/([^/]+))?/?$`, "i");

const safeSubpath = (input: string, subpath: string | undefined): string | null => {
  if (!subpath) return null;
  const segments = decodeURIComponent(subpath).split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment === ".")) throw new InvalidImportSource(input);
  return segments.length > 0 ? segments.join("/") : null;
};

const validRepo = (owner: string, repo: string) => !/^\.\.?$/.test(owner) && !/^\.\.?$/.test(repo);

/**
 * Reads what was pasted (#11): `owner/repo`, `https://github.com/owner/repo`,
 * a tree URL `github.com/o/r/tree/<ref>/<path>` (limits the search to the path
 * and sets the tracked ref; a branch with `/` in its name can't be told apart
 * from the path here, so the Importer resolves it against GitHub) or a skills.sh listing URL
 * `skills.sh/<owner>/<repo>/<skill>`. GitHub only in v1.
 */
export const parseImportSource = (raw: string): ImportSource => {
  const input = raw.trim().replace(/[?#].*$/, "");
  const shorthand = input.match(SHORTHAND);
  if (shorthand?.[1] && shorthand[2] && validRepo(shorthand[1], shorthand[2])) {
    return { fullName: `${shorthand[1]}/${shorthand[2]}`, ref: null, subpath: null, skill: null };
  }
  const github = input.match(GITHUB_URL);
  if (github?.[1] && github[2] && validRepo(github[1], github[2])) {
    const subpath = safeSubpath(raw, github[4]);
    const ref = github[3] ? decodeURIComponent(github[3]) : null;
    return {
      fullName: `${github[1]}/${github[2]}`,
      ref,
      subpath,
      skill: null,
      ...(ref && { treePath: subpath ? `${ref}/${subpath}` : ref }),
    };
  }
  const listing = input.match(SKILLS_SH_URL);
  if (listing?.[1] && listing[2] && validRepo(listing[1], listing[2])) {
    return {
      fullName: `${listing[1]}/${listing[2]}`,
      ref: null,
      subpath: null,
      skill: listing[3] ? decodeURIComponent(listing[3]) : null,
    };
  }
  throw new InvalidImportSource(raw.trim());
};
