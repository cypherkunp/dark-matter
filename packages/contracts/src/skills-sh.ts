import { z } from "zod";

/**
 * skills.sh search and Get (#31): schemas for the `skillsSh` domain. Search
 * calls skills.sh's public `/api/search` (30 requests a minute per IP); Get
 * resolves a listing to its GitHub repo and Imports it like GitHub Import.
 */

export const SkillsShSearchInput = z.object({ query: z.string() });
export type SkillsShSearchInput = z.infer<typeof SkillsShSearchInput>;

/** One skills.sh listing. */
export const SkillsShListing = z.object({
  /** `<owner>/<repo>/<slug>`; the listing's page is `https://skills.sh/<id>`. */
  id: z.string(),
  /** The GitHub repo, `owner/repo`. */
  source: z.string(),
  slug: z.string(),
  name: z.string(),
  installs: z.number(),
  url: z.string(),
  /** The Library key when it's already in the Library (same Source and Skill), else null. */
  key: z.string().nullable(),
});
export type SkillsShListing = z.infer<typeof SkillsShListing>;

export const SkillsShSearch = z.object({
  query: z.string(),
  skills: z.array(SkillsShListing),
  /**
   * Set when skills.sh's rate limit (30 searches a minute) is used up: no
   * results until then (ISO time). Not an error, so the screen can say so.
   */
  rateLimitedUntil: z.string().nullable(),
});
export type SkillsShSearch = z.infer<typeof SkillsShSearch>;

export const SkillsShGetInput = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[^/]+$/, "A skills.sh listing id: owner/repo/slug"),
});
export type SkillsShGetInput = z.infer<typeof SkillsShGetInput>;
