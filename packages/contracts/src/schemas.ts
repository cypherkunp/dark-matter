import { z } from "zod";

/** Who is calling the core. Every mutation will carry this (ADR-0006). */
export const ClientKind = z.enum(["app", "cli", "mcp"]);
export type ClientKind = z.infer<typeof ClientKind>;

/**
 * `~/.dark-matter/core.json`: how local clients find the running core (ADR-0003).
 * Written by the core with mode 0600 and removed when it stops.
 */
export const CoreFile = z.object({
  pid: z.int().positive(),
  port: z.int().min(1).max(65_535),
  token: z.string().min(32),
  version: z.string(),
});
export type CoreFile = z.infer<typeof CoreFile>;

/** What a client needs to open a connection to the core. */
export const CoreConnection = CoreFile.pick({ port: true, token: true });
export type CoreConnection = z.infer<typeof CoreConnection>;

/** The first message on every connection (tRPC `connectionParams`). */
export const ConnectionParams = z.object({
  token: z.string(),
  client: ClientKind,
});
export type ConnectionParams = z.infer<typeof ConnectionParams>;

export const CoreInfo = z.object({
  version: z.string(),
  pid: z.int().positive(),
  /** The Library location: `DARK_MATTER_HOME`, or `$HOME/.dark-matter`. */
  libraryHome: z.string(),
  startedAt: z.iso.datetime(),
});
export type CoreInfo = z.infer<typeof CoreInfo>;

export const LibrarySkill = z.object({
  /** `<namespace>/<name>`, the Library Lock key. */
  key: z.string(),
  namespace: z.string(),
  name: z.string(),
  description: z.string(),
});
export type LibrarySkill = z.infer<typeof LibrarySkill>;

export const LibraryList = z.object({
  skills: z.array(LibrarySkill),
});
export type LibraryList = z.infer<typeof LibraryList>;

/** Activity Log retention: days of `activity/*.jsonl` kept, or forever (ADR-0005). */
export const ActivityRetention = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
  z.literal(365),
  z.literal("forever"),
]);
export type ActivityRetention = z.infer<typeof ActivityRetention>;

const preferenceFields = {
  /** Local time of the daily Scheduled Scan, `HH:MM`. */
  scheduledScanTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM"),
  startAtLogin: z.boolean(),
  /** Days a deleted Library Skill stays in `trash/`. */
  trashRetentionDays: z.int().positive(),
  activityRetention: ActivityRetention,
};

export const Preferences = z.strictObject({
  scheduledScanTime: preferenceFields.scheduledScanTime.default("09:00"),
  startAtLogin: preferenceFields.startAtLogin.default(true),
  trashRetentionDays: preferenceFields.trashRetentionDays.default(30),
  activityRetention: preferenceFields.activityRetention.default(30),
});
export type Preferences = z.infer<typeof Preferences>;

/**
 * `~/.dark-matter/settings.json`, owned intent (ADR-0005). Every field has a
 * default, so a missing file is an empty object. Later tickets add Favourites,
 * Collections, ignored findings, dismissed Suggested Projects and First run here.
 */
export const SettingsFile = z.strictObject({
  preferences: Preferences.prefault({}),
});
export type SettingsFile = z.infer<typeof SettingsFile>;

/** The preferences a save changes. No defaults here, so omitted fields stay as they are. */
export const PreferencesPatch = z.strictObject(preferenceFields).partial();
export type PreferencesPatch = z.infer<typeof PreferencesPatch>;

/** The owned files the core watches and validates. */
export const OwnedFileName = z.enum(["settings.json"]);
export type OwnedFileName = z.infer<typeof OwnedFileName>;

/** A hand edit the core is holding because it doesn't validate. */
export const OwnedFileProblem = z.object({
  file: OwnedFileName,
  path: z.string(),
  message: z.string(),
});
export type OwnedFileProblem = z.infer<typeof OwnedFileProblem>;

/** Who made a change, as the Activity Log records it (ADR-0006). */
export const ActivityClient = z.enum(["app", "cli", "mcp", "scheduled-scan"]);
export type ActivityClient = z.infer<typeof ActivityClient>;

/** What an Activity entry is about; `id` is a Skill key, Project path, file name… */
export const ActivitySubject = z.object({
  kind: z.enum(["settings", "skill", "project", "mcpServer", "source"]),
  id: z.string(),
});
export type ActivitySubject = z.infer<typeof ActivitySubject>;

/** One line of `activity/YYYY-MM-DD.jsonl` (UTC date of `time`). */
export const ActivityEntry = z.object({
  id: z.string(),
  time: z.iso.datetime(),
  client: ActivityClient,
  /** `<domain>.<operation>`, e.g. `settings.updatePreferences`. */
  action: z.string(),
  subjects: z.array(ActivitySubject),
  result: z.enum(["ok", "error"]),
  error: z.object({ tag: z.string().nullable(), message: z.string() }).optional(),
  /** Home-relative (`~/…`) where possible. */
  filesWritten: z.array(z.string()),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

export const ActivityQuery = z.object({ limit: z.int().min(1).max(5_000).default(500) }).prefault({});
export type ActivityQuery = z.infer<typeof ActivityQuery>;

export const ActivityList = z.object({
  /** Newest first. */
  entries: z.array(ActivityEntry),
});
export type ActivityList = z.infer<typeof ActivityList>;

/** Router domains a client caches; an `invalidate` event names the ones that changed. */
export const Domain = z.enum(["core", "library", "settings", "ownedFiles", "activity"]);
export type Domain = z.infer<typeof Domain>;

/** Pushed over the `events` subscription to drive TanStack Query invalidation. */
export const CoreEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("invalidate"), domains: z.array(Domain).min(1) }),
]);
export type CoreEvent = z.infer<typeof CoreEvent>;

/** Exit codes of the core process, so a supervisor can tell why it stopped. */
export const CoreExitCode = {
  /** Another core holds `core.lock`: attach to it instead. */
  locked: 75,
  failed: 1,
} as const;
