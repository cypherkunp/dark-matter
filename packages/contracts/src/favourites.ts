import { z } from "zod";
import { LibrarySkill } from "./schemas";

/**
 * Favourites (#35): schemas for the `favourites` domain. A star sits on a
 * Library Skill or a Source (`owner/repo`); both live in `settings.json`.
 */

/** `owner/repo`, as GitHub names them. */
export const SourceName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "a Source is owner/repo");

export const StarSkillInput = z.object({ key: z.string().min(1), starred: z.boolean() });
export type StarSkillInput = z.infer<typeof StarSkillInput>;

export const StarSourceInput = z.object({ source: SourceName, starred: z.boolean() });
export type StarSourceInput = z.infer<typeof StarSourceInput>;

/** What's starred. */
export const Favourites = z.object({
  skills: z.array(z.string()),
  sources: z.array(z.string()),
});
export type Favourites = z.infer<typeof Favourites>;

/** A starred Source on the Favourites view. */
export const FavouriteSource = z.object({
  source: z.string(),
  /** Library Skills from it. */
  skills: z.int().nonnegative(),
  /** Skills it gained that wait in the Inbox (ignored ones left out). */
  newSkills: z.int().nonnegative(),
  /** The last update check that looked at it; null before one. */
  checkedAt: z.iso.datetime().nullable(),
});
export type FavouriteSource = z.infer<typeof FavouriteSource>;

/** The Favourites view: starred Skills plus every Library Skill from a starred Source. */
export const FavouritesView = z.object({
  skills: z.array(LibrarySkill),
  sources: z.array(FavouriteSource),
});
export type FavouritesView = z.infer<typeof FavouritesView>;
