import { z } from "zod";

/**
 * GitHub Import (#30): schemas for the `importer` domain. An Import fetches
 * chosen Skills from a GitHub repo into the Library, pinned to a commit and
 * following a tracked ref.
 */

/** What you pasted: `owner/repo`, a repo URL, a tree URL or a skills.sh listing URL. */
export const ImportSourceInput = z.object({ input: z.string().trim().min(1) });
export type ImportSourceInput = z.infer<typeof ImportSourceInput>;

/** How the core talks to GitHub: the `gh` CLI's token, a PAT in the keychain, or anonymously (public repos only). */
export const GitHubAuthMethod = z.enum(["gh", "pat", "anonymous"]);
export type GitHubAuthMethod = z.infer<typeof GitHubAuthMethod>;

export const GitHubAuthStatus = z.object({
  method: GitHubAuthMethod,
  /** A PAT is stored in the keychain (it's used only when `gh` isn't logged in). */
  pat: z.boolean(),
});
export type GitHubAuthStatus = z.infer<typeof GitHubAuthStatus>;

/** A PAT to store in the keychain, or null to remove it. */
export const SetGitHubTokenInput = z.object({ token: z.string().trim().min(1).nullable() });
export type SetGitHubTokenInput = z.infer<typeof SetGitHubTokenInput>;

/** One Skill found in the Source, as the picker shows it. */
export const ImportCandidate = z.object({
  name: z.string(),
  description: z.string(),
  /** The Skill folder in the repo, `/`-separated; `.` for a root SKILL.md. */
  path: z.string(),
  /** Its SKILL.md, for Preview. */
  skillMd: z.string(),
  /** Ticked when the picker opens: the only Skill found, or the one a skills.sh listing named. */
  selected: z.boolean(),
  /** The Library key it lands under, or already has when `inLibrary`. */
  key: z.string(),
  /** Imported before from the same Source and path: Importing it again checks for an update instead. */
  inLibrary: z.boolean(),
});
export type ImportCandidate = z.infer<typeof ImportCandidate>;

/** What a Source holds at its tracked ref's head: the picker's content. Nothing is written. */
export const ImportPreview = z.object({
  /** `owner/repo`, also the Namespace. */
  source: z.string(),
  /** The tracked ref: the default branch, or the branch or tag from a tree URL. */
  ref: z.string(),
  /** The commit the Skills were found at; Import pins exactly this one. */
  commit: z.string(),
  /** The folder a tree URL limited the search to, else null. */
  subpath: z.string().nullable(),
  auth: GitHubAuthMethod,
  skills: z.array(ImportCandidate),
});
export type ImportPreview = z.infer<typeof ImportPreview>;

export const ImportSkillsInput = ImportSourceInput.extend({
  /** The commit from the preview, so the Import is exactly what the picker showed. */
  commit: z.string().regex(/^[0-9a-f]{40}$/, "A full commit SHA"),
  /** Picked Skill folders (`ImportCandidate.path`). */
  paths: z.array(z.string().min(1)).min(1),
});
export type ImportSkillsInput = z.infer<typeof ImportSkillsInput>;

/** What Import did with one picked Skill. Re-importing never duplicates: it checks for an update. */
export const ImportOutcome = z.enum(["imported", "upToDate", "updateAvailable"]);
export type ImportOutcome = z.infer<typeof ImportOutcome>;

export const ImportResult = z.object({
  source: z.string(),
  ref: z.string(),
  commit: z.string(),
  skills: z.array(z.object({ key: z.string(), path: z.string(), outcome: ImportOutcome })),
});
export type ImportResult = z.infer<typeof ImportResult>;
