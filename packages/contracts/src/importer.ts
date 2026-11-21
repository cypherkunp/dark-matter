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

/**
 * Updates (#33, decided in #11 points 5–8 and 10). Checks are per Source:
 * one call for the tracked ref's head, then one Trees call if it moved.
 */

/** One Library Skill with a newer upstream folder, waiting for you to apply it. */
export const SkillUpdate = z.object({
  key: z.string(),
  source: z.string(),
  ref: z.string(),
  /** The commit the Library has. */
  commit: z.string().nullable(),
  /** The tracked ref's head, where the update comes from. */
  head: z.string(),
  /** The Skill folder's tree SHA at `head`. */
  folderSha: z.string(),
  /** Changed locally since it was Imported: applying needs Take upstream, Keep mine or Detach. */
  modified: z.boolean(),
  checkedAt: z.string(),
});
export type SkillUpdate = z.infer<typeof SkillUpdate>;

/** The last check of one Source (cached in SQLite only). */
export const SourceCheckStatus = z.object({
  source: z.string(),
  ref: z.string(),
  /** Last head seen; null when the check failed. */
  head: z.string().nullable(),
  checkedAt: z.string(),
  /** Why the last check failed (offline, rate limited, gone). */
  error: z.string().nullable(),
});
export type SourceCheckStatus = z.infer<typeof SourceCheckStatus>;

/** GitHub as the last check saw it (cached in SQLite only). */
export const GitHubCheckStatus = z.object({
  auth: GitHubAuthMethod,
  rateLimit: z.object({ remaining: z.int(), limit: z.int().nullable(), resetAt: z.string().nullable() }).nullable(),
  checkedAt: z.string(),
});
export type GitHubCheckStatus = z.infer<typeof GitHubCheckStatus>;

export const OrphanedSkill = z.object({ key: z.string(), source: z.string(), reason: z.string() });
export type OrphanedSkill = z.infer<typeof OrphanedSkill>;

/** The Updates list. */
export const UpdatesView = z.object({
  updates: z.array(SkillUpdate),
  orphaned: z.array(OrphanedSkill),
  sources: z.array(SourceCheckStatus),
  github: GitHubCheckStatus.nullable(),
});
export type UpdatesView = z.infer<typeof UpdatesView>;

/** Check for updates: every Imported Skill's Source, or only the Sources of `keys` (Check upstream). */
export const CheckUpdatesInput = z.object({ keys: z.array(z.string().min(1)).optional() });
export type CheckUpdatesInput = z.infer<typeof CheckUpdatesInput>;

/** What to do with an update that meets a Modified Skill. */
export const UpdateChoice = z.enum(["takeUpstream", "keepMine", "detach"]);
export type UpdateChoice = z.infer<typeof UpdateChoice>;

export const ApplyUpdatesInput = z.object({
  updates: z.array(z.object({ key: z.string().min(1), choice: UpdateChoice.optional() })).min(1),
});
export type ApplyUpdatesInput = z.infer<typeof ApplyUpdatesInput>;

export const AppliedUpdates = z.object({
  skills: z.array(
    z.object({
      key: z.string(),
      outcome: z.enum(["updated", "kept", "detached"]),
      /** The Library key afterwards (`local/<name>` once Detached). */
      newKey: z.string(),
    }),
  ),
});
export type AppliedUpdates = z.infer<typeof AppliedUpdates>;

export const UpdateDiff = z.object({ key: z.string(), patch: z.string() });
export type UpdateDiff = z.infer<typeof UpdateDiff>;

/** Re-point a Skill (Orphaned, or pinned to a tag) at a repo, tree URL or tag. */
export const RepointInput = z.object({ key: z.string().min(1), input: z.string().trim().min(1) });
export type RepointInput = z.infer<typeof RepointInput>;

export const SkillKeyInput = z.object({ key: z.string().min(1) });

export const DetachResult = z.object({ key: z.string(), newKey: z.string() });
export type DetachResult = z.infer<typeof DetachResult>;
