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
  /** The folder a Local Source Skill is authored in, home-relative; null for a Skill the Library holds. */
  localSource: z.string().nullable(),
  /** Where Adopt moved it from, home-relative; null if it wasn't Adopted. */
  adoptedFrom: z.string().nullable(),
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
  /** Inbox findings you chose to leave alone, by finding id. Kept sorted. */
  ignoredFindings: z.array(z.string()).default([]),
});
export type SettingsFile = z.infer<typeof SettingsFile>;

/** The preferences a save changes. No defaults here, so omitted fields stay as they are. */
export const PreferencesPatch = z.strictObject(preferenceFields).partial();
export type PreferencesPatch = z.infer<typeof PreferencesPatch>;

/** A symlink as it was on disk: `target` is the raw link text, so it can be put back exactly. */
export const SymlinkRecord = z.object({ path: z.string(), target: z.string() });
export type SymlinkRecord = z.infer<typeof SymlinkRecord>;

/**
 * One Library Skill's provenance: a skills-lock v2 entry (`source`, `sourceType`,
 * `ref`, `commit`, `skillPath`, `computedHash`) plus Dark Matter's fields.
 * Paths are home-relative (`~/…`).
 */
export const LibraryLockEntry = z.strictObject({
  source: z.string(),
  sourceType: z.string(),
  ref: z.string().optional(),
  commit: z.string().optional(),
  skillPath: z.string().optional(),
  computedHash: z.string(),
  /** The real folder Adopt moved into the Library (or, for a Local Source, the global symlink it replaced). */
  adoptedFrom: z.string().optional(),
  /** Global symlinks Adopt removed, put back by Undo Adopt. */
  adoptedLinks: z.array(SymlinkRecord).optional(),
  /** Identical global copies (same content) Adopt merged into this Skill, put back by Undo Adopt. */
  adoptedCopies: z.array(z.string()).optional(),
  /** Its entry in the `skills` CLI's global lock as Adopt removed it, put back by Undo Adopt. */
  skillLockEntry: z
    .strictObject({ path: z.string(), name: z.string(), entry: z.record(z.string(), z.unknown()) })
    .optional(),
  /** A Local Source: the folder it's authored in. The Library holds a symlink to it. */
  localSource: z.string().optional(),
});
export type LibraryLockEntry = z.infer<typeof LibraryLockEntry>;

/** `~/.dark-matter/library-lock.json`, the Library Lock, keyed by `<namespace>/<name>` (ADR-0001). */
export const LibraryLockFile = z.strictObject({
  version: z.literal(1).default(1),
  skills: z.record(z.string(), LibraryLockEntry).default({}),
});
export type LibraryLockFile = z.infer<typeof LibraryLockFile>;

/** The owned files the core watches and validates. */
export const OwnedFileName = z.enum(["settings.json", "library-lock.json"]);
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
  kind: z.enum(["settings", "skill", "project", "mcpServer", "source", "finding"]),
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

/** A v1 Agent, as Dark Matter's adapters know it. */
export const AgentId = z.enum(["claude-code", "cursor", "opencode", "codex", "agents"]);
export type AgentId = z.infer<typeof AgentId>;

/** One place an Agent skill folder reaches a Skill. Paths are home-relative. */
export const SkillLocation = z.object({
  /** The Agent skill folder, e.g. `~/.claude/skills`. */
  folder: z.string(),
  /** The entry in that folder, e.g. `~/.claude/skills/pdf`. */
  path: z.string(),
  /** The entry is a symlink to the Skill's real folder. */
  symlink: z.boolean(),
});
export type SkillLocation = z.infer<typeof SkillLocation>;

/**
 * A Skill in some Agent's global folder, found by a Scan. One per resolved real
 * path, however many symlinks reach it.
 */
export const GlobalSkill = z.object({
  /** Stable across Scans: `global-skill:<realPath>`. Ignoring a finding records this. */
  id: z.string(),
  /** Frontmatter `name`, else the folder name. */
  name: z.string(),
  description: z.string(),
  /** The Skill's identity: its resolved real folder, home-relative. */
  realPath: z.string(),
  /** The Agent folder the Inbox groups it under: the one holding its real folder, else the first that links to it. */
  folder: z.string(),
  locations: z.array(SkillLocation).min(1),
  /** Every Agent that loads it through one of its locations. */
  agents: z.array(AgentId),
  /** `owner/repo` from the `skills` CLI's global lock, when it installed this Skill. */
  source: z.string().nullable(),
  /** Its real folder is outside every Agent folder, so Adopt makes it a Local Source. */
  localSource: z.boolean(),
});
export type GlobalSkill = z.infer<typeof GlobalSkill>;

/** What a Scan saw of one Agent. */
export const AgentScan = z.object({
  id: AgentId,
  /** The Agent's own folder exists (e.g. `~/.claude`). */
  detected: z.boolean(),
  /** Global skill folders it loads, home-relative; the first is its own. */
  globalSkillFolders: z.array(z.object({ path: z.string(), exists: z.boolean() })),
  /** Global Skills it loads, counted once per real path. */
  globalSkillCount: z.int().nonnegative(),
});
export type AgentScan = z.infer<typeof AgentScan>;

/** Everything one Scan found. Cached in `state/`; rebuilt by scanning again. */
export const ScanResult = z.object({
  scannedAt: z.iso.datetime(),
  agents: z.array(AgentScan),
  globalSkills: z.array(GlobalSkill),
});
export type ScanResult = z.infer<typeof ScanResult>;

export const ScanStatus = z.object({
  running: z.boolean(),
  /** When the last Scan finished; null before the first. */
  lastScanAt: z.iso.datetime().nullable(),
});
export type ScanStatus = z.infer<typeof ScanStatus>;

/** Global Skills in one Agent folder, for the Inbox. */
export const InboxFolderGroup = z.object({
  folder: z.string(),
  /** The Agents that load this folder. */
  agents: z.array(AgentId),
  findings: z.array(GlobalSkill),
});
export type InboxFolderGroup = z.infer<typeof InboxFolderGroup>;

/** Findings still waiting on a decision. Ignored findings are left out. */
export const Inbox = z.object({
  /** The badge: findings waiting, across every kind. */
  count: z.int().nonnegative(),
  globalSkills: z.array(InboxFolderGroup),
  ignoredCount: z.int().nonnegative(),
});
export type Inbox = z.infer<typeof Inbox>;

/** One card on the Agents screen. */
export const AgentCard = z.object({
  id: AgentId,
  name: z.string(),
  /** Null until the first Scan. */
  detected: z.boolean().nullable(),
  /** Its own global skill folder, home-relative. */
  globalSkillFolder: z.string(),
  /** Null until the first Scan. */
  globalSkillCount: z.int().nonnegative().nullable(),
});
export type AgentCard = z.infer<typeof AgentCard>;

/**
 * One filesystem change in a plan. Every mutation that writes files returns its
 * plan (a dry run) before it is applied; paths are home-relative.
 */
export const PlanStep = z.discriminatedUnion("kind", [
  /** Move a folder (rename, or copy through `staging/` across devices). */
  z.object({ kind: z.literal("move"), from: z.string(), to: z.string() }),
  /** Copy a folder (Undo Adopt putting back a merged identical copy). */
  z.object({ kind: z.literal("copy"), from: z.string(), to: z.string() }),
  z.object({ kind: z.literal("createLink"), path: z.string(), target: z.string() }),
  /** Remove a symlink; its target is untouched. */
  z.object({ kind: z.literal("removeLink"), path: z.string(), target: z.string() }),
  /** Remove a copy whose content is identical to `sameAs`, which is kept. */
  z.object({ kind: z.literal("removeCopy"), path: z.string(), sameAs: z.string() }),
  /** Rewrite an owned or foreign file, e.g. `library-lock.json` or the `skills` CLI's global lock. */
  z.object({ kind: z.literal("editFile"), path: z.string(), change: z.string(), backup: z.string().optional() }),
]);
export type PlanStep = z.infer<typeof PlanStep>;

/** What every plan carries; a domain's plan adds its own summary fields. */
export const PlanBase = z.object({
  /** Changes when anything in the plan would change; apply refuses a stale id (`PlanStale`). */
  planId: z.string(),
  steps: z.array(PlanStep),
  warnings: z.array(z.string()),
});

/** A diff between two Skills' files, for same-name variants. */
export const SkillDiff = z.object({
  /** The Library key or finding the variant differs from. */
  against: z.string(),
  /** A unified diff of every changed text file; binary files are named only. */
  patch: z.string(),
});
export type SkillDiff = z.infer<typeof SkillDiff>;

/** What Adopt does with one Skill. */
export const AdoptOutcome = z.enum([
  /** Moved into the Library. */
  "moved",
  /** Same content as another Skill in this Adopt or the Library: one Library Skill, the copy removed. */
  "merged",
  /** Same name, different content: kept side by side under another Namespace or `<name>-<shorthash>`. */
  "variant",
  /** Authored outside every Agent folder: the Library refers to it in place. */
  "localSource",
]);
export type AdoptOutcome = z.infer<typeof AdoptOutcome>;

export const AdoptPlanSkill = z.object({
  finding: z.string(),
  name: z.string(),
  /** The Library Lock key it ends up under. */
  key: z.string(),
  namespace: z.string(),
  outcome: AdoptOutcome,
  computedHash: z.string(),
  diff: SkillDiff.nullable(),
});
export type AdoptPlanSkill = z.infer<typeof AdoptPlanSkill>;

export const AdoptPlan = PlanBase.extend({
  findings: z.array(z.string()),
  skills: z.array(AdoptPlanSkill),
});
export type AdoptPlan = z.infer<typeof AdoptPlan>;

export const AdoptInput = z.object({ findings: z.array(z.string().min(1)).min(1) });
export type AdoptInput = z.infer<typeof AdoptInput>;

export const ApplyAdoptInput = AdoptInput.extend({ planId: z.string() });
export type ApplyAdoptInput = z.infer<typeof ApplyAdoptInput>;

/** Router domains a client caches; an `invalidate` event names the ones that changed. */
export const Domain = z.enum(["core", "library", "settings", "ownedFiles", "activity", "scan", "inbox", "agents"]);
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
