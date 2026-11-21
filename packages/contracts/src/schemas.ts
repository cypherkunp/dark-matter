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
  /** The Agent behind an `mcp` (or `cli`) client, by name, for Requests and the Activity Log (ADR-0006). */
  agent: z.string().min(1).max(100).optional(),
});
export type ConnectionParams = z.infer<typeof ConnectionParams>;

/** Where a Request is: waiting for you, or what became of it. */
export const RequestStatus = z.enum(["pending", "applied", "denied", "failed", "expired"]);
export type RequestStatus = z.infer<typeof RequestStatus>;

/**
 * Why a Request asks instead of going through on the Project's Grant: no Grant,
 * or a change a Grant never covers (a Copy, a Shared or new MCP Server, an
 * Import, discarding edits in the repo).
 */
export const RequestReason = z.enum(["noGrant", "copy", "sharedMcpServer", "mcpServer", "import", "discardEdits"]);
export type RequestReason = z.infer<typeof RequestReason>;

/**
 * A Request (ADR-0006): a change a client other than the app asked for, kept
 * in `requests.json` until it's decided and for 24 hours after it was made.
 */
export const RequestRecord = z.strictObject({
  id: z.string(),
  client: ClientKind,
  agent: z.string().optional(),
  /** The mutation asked for, by procedure path, e.g. `project.addSkills`. */
  operation: z.string(),
  /** Its input, exactly as asked. */
  input: z.unknown(),
  /** The Projects it changes, by absolute path. */
  projects: z.array(z.string()),
  /** The plan, in words. */
  summary: z.string(),
  reasons: z.array(RequestReason),
  createdAt: z.iso.datetime(),
  /** 24 hours after it was made; a pending Request then expires. */
  expiresAt: z.iso.datetime(),
  status: RequestStatus,
  decidedAt: z.iso.datetime().optional(),
  /** Why applying an approved Request failed (re-validated against the state then). */
  error: z.object({ tag: z.string().nullable(), message: z.string() }).optional(),
});
export type RequestRecord = z.infer<typeof RequestRecord>;

/** A pending Request as the Inbox lists it: its raw input stays with `requests.get`. */
export const PendingRequest = RequestRecord.omit({ input: true });
export type PendingRequest = z.infer<typeof PendingRequest>;

/** `~/.dark-matter/requests.json`: Requests by id. */
export const RequestsFile = z.strictObject({
  requests: z.record(z.string(), RequestRecord).default({}),
});
export type RequestsFile = z.infer<typeof RequestsFile>;

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
  /** Changed since it was last Imported: its files no longer match the Library Lock's computedHash. */
  modified: z.boolean(),
  /** How many Projects use it (On or Off). */
  projects: z.int().nonnegative(),
  /** It's in a Name Conflict in at least one Project. */
  nameConflict: z.boolean(),
  /** Its upstream is gone (#33): kept as is until you Detach or re-point it. */
  orphaned: z.boolean().default(false),
});
export type LibrarySkill = z.infer<typeof LibrarySkill>;

export const LibraryList = z.object({
  skills: z.array(LibrarySkill),
});
export type LibraryList = z.infer<typeof LibraryList>;

/** SKILL.md frontmatter rules from the Agent Skills spec; problems are warnings, never errors. */
export const SkillName = z
  .string()
  .max(64, "name must be at most 64 characters")
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be lowercase letters, numbers and single hyphens");
export const SkillDescription = z
  .string()
  .trim()
  .min(1, "description is empty")
  .max(1024, "description must be at most 1024 characters");

/** A SKILL.md frontmatter problem shown as a warning. */
export const FrontmatterWarning = z.object({
  field: z.enum(["frontmatter", "name", "description"]),
  message: z.string(),
});
export type FrontmatterWarning = z.infer<typeof FrontmatterWarning>;

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

/** A Collection's name: its key in `settings.json` and how it shows under Library. */
export const CollectionName = z
  .string()
  .trim()
  .min(1, "Give the Collection a name")
  .max(80, "Use at most 80 characters")
  .refine((name) => !name.includes("\n"), "Use one line");

/** One thing in a Collection: a Library Skill by key, or a Library MCP Server by name (#41). */
export const CollectionItem = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("skill"), key: z.string().min(1) }),
  z.strictObject({ kind: z.literal("mcpServer"), name: z.string().min(1) }),
]);
export type CollectionItem = z.infer<typeof CollectionItem>;

/** A Collection in `settings.json`: a template, flat (no nesting), applied by copying its items into Projects. */
export const CollectionRecord = z.strictObject({
  items: z.array(CollectionItem).default([]),
});
export type CollectionRecord = z.infer<typeof CollectionRecord>;

/** Favourites (#35): starred Library Skills (by key) and starred Sources (`owner/repo`). Both kept sorted. */
export const FavouritesRecord = z.strictObject({
  skills: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
});
export type FavouritesRecord = z.infer<typeof FavouritesRecord>;

/**
 * `~/.dark-matter/settings.json`, owned intent (ADR-0005). Every field has a
 * default, so a missing file is an empty object. Later tickets add Favourites,
 * Collections, ignored findings, dismissed Suggested Projects and First run here.
 */
export const SettingsFile = z.strictObject({
  preferences: Preferences.prefault({}),
  /** Inbox findings you chose to leave alone, by finding id. Kept sorted. */
  ignoredFindings: z.array(z.string()).default([]),
  /** Suggested Projects you dismissed, by absolute path. Kept sorted. */
  dismissedSuggestedProjects: z.array(z.string()).default([]),
  /** Collections by name (#36). Items keep their order. */
  collections: z.record(z.string(), CollectionRecord).default({}),
  /** Set when the First run is finished or skipped (#46), so it runs once. Absent until then. */
  firstRun: z.strictObject({ completedAt: z.iso.datetime() }).optional(),
  /** Starred Skills and Sources (#35). Absent until something is starred. */
  favourites: FavouritesRecord.optional(),
  /**
   * Inbox findings (Global Skills, Global MCP Servers, drift) the Scheduled Scan
   * has already told you about, or that were there when it first ran, by id.
   * Kept sorted; absent until the first Scheduled Scan.
   */
  notifiedFindings: z.array(z.string()).optional(),
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
  /** Projects (home-relative) where Adopt & keep Link put a Link back (#29); Undo Adopt removes those Project Skills first. */
  keptLinks: z.array(z.string()).optional(),
  /** Imported (#30): the GitHub tree SHA of the Skill's folder at `commit`, so update checks compare folders, not commits. */
  skillFolderHash: z.string().optional(),
  /** Updates (#33): `tag` when `ref` is a tag, so it only moves when re-pointed. Absent = a branch. */
  refType: z.enum(["branch", "tag"]).optional(),
  /** Keep mine (#33): the upstream folder tree SHA you skipped; you're asked again only for a newer one. */
  skippedUpdate: z.string().optional(),
  /** Orphaned (#33): why the upstream can't be found any more. Cleared when it comes back or is re-pointed. */
  orphaned: z.string().optional(),
  /** Detach (#33): where a `local` Skill came from before it was cut off. */
  detachedFrom: z.strictObject({ key: z.string(), source: z.string(), skillPath: z.string().optional() }).optional(),
});
export type LibraryLockEntry = z.infer<typeof LibraryLockEntry>;

/** `~/.dark-matter/library-lock.json`, the Library Lock, keyed by `<namespace>/<name>` (ADR-0001). */
export const LibraryLockFile = z.strictObject({
  version: z.literal(1).default(1),
  skills: z.record(z.string(), LibraryLockEntry).default({}),
});
export type LibraryLockFile = z.infer<typeof LibraryLockFile>;

/** One Library Skill as its page shows it (#24). */
export const SkillDetail = z.object({
  key: z.string(),
  namespace: z.string(),
  /** The folder name, the key's last segment. */
  name: z.string(),
  /** The Skill's folder in the Library, absolute (a symlink for a Local Source). */
  path: z.string(),
  /** The raw YAML between the `---` fences; null when SKILL.md has none. */
  frontmatter: z.string().nullable(),
  /** SKILL.md after the frontmatter. */
  body: z.string(),
  warnings: z.array(FrontmatterWarning),
  entry: LibraryLockEntry,
  /** See LibrarySkill.modified. */
  modified: z.boolean(),
});
export type SkillDetail = z.infer<typeof SkillDetail>;

/** A file in a Skill folder, `/`-separated and relative to it. */
export const SkillFilePath = z.object({ key: z.string().min(1), path: z.string().min(1) });
export type SkillFilePath = z.infer<typeof SkillFilePath>;

/** One entry of a Skill's file tree (#34). Binary files are listed but not editable. */
export const SkillFileEntry = z.object({ path: z.string(), size: z.int().nonnegative(), binary: z.boolean() });
export type SkillFileEntry = z.infer<typeof SkillFileEntry>;

export const SkillFiles = z.object({ files: z.array(SkillFileEntry) });
export type SkillFiles = z.infer<typeof SkillFiles>;

/** A file's text for the editor; `content` is null for a binary file. */
export const SkillFileContent = z.object({ path: z.string(), content: z.string().nullable(), binary: z.boolean() });
export type SkillFileContent = z.infer<typeof SkillFileContent>;

export const SaveSkillFileInput = SkillFilePath.extend({ content: z.string() });
export type SaveSkillFileInput = z.infer<typeof SaveSkillFileInput>;

/** After a save: SKILL.md's frontmatter warnings (never blocking) and whether the Skill is now Modified. */
export const SavedSkillFile = z.object({ warnings: z.array(FrontmatterWarning), modified: z.boolean() });
export type SavedSkillFile = z.infer<typeof SavedSkillFile>;

/** A Project a Library Skill's deletion would affect: its Links break, its Copies stay behind. */
export const SkillDeleteImpact = z.object({
  path: z.string(),
  projectName: z.string(),
  mode: z.string(),
  on: z.boolean(),
});
export type SkillDeleteImpact = z.infer<typeof SkillDeleteImpact>;

/** What deleting a Library Skill would do: move it to `trash/` for `retentionDays`, and the Projects affected. */
export const SkillDeletePlan = z.object({
  key: z.string(),
  retentionDays: z.int().positive(),
  projects: z.array(SkillDeleteImpact),
});
export type SkillDeletePlan = z.infer<typeof SkillDeletePlan>;

/** The owned files the core watches and validates. */
export const OwnedFileName = z.enum(["settings.json", "projects.json", "library-lock.json", "requests.json"]);
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
  kind: z.enum(["settings", "skill", "project", "mcpServer", "source", "finding", "collection", "request"]),
  id: z.string(),
});
export type ActivitySubject = z.infer<typeof ActivitySubject>;

/** One line of `activity/YYYY-MM-DD.jsonl` (UTC date of `time`). */
export const ActivityEntry = z.object({
  id: z.string(),
  time: z.iso.datetime(),
  client: ActivityClient,
  /** The Agent behind an `mcp` or `cli` client, when it gave its name (ADR-0006). */
  agent: z.string().optional(),
  /** The Request this change applied, if it was one. */
  request: z.string().optional(),
  /** `<domain>.<operation>`, e.g. `settings.updatePreferences`. */
  action: z.string(),
  subjects: z.array(ActivitySubject),
  result: z.enum(["ok", "error"]),
  error: z.object({ tag: z.string().nullable(), message: z.string() }).optional(),
  /** Home-relative (`~/…`) where possible. */
  filesWritten: z.array(z.string()),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

/**
 * A filtered view of the Activity Log. Every filter is optional and they all
 * apply together; list filters match any of their values.
 */
export const ActivityFilter = z.object({
  actions: z.array(z.string()).optional(),
  clients: z.array(ActivityClient).optional(),
  /** A Library Skill key: entries with that `skill` subject. */
  skill: z.string().optional(),
  /** A Project's absolute path: entries with that `project` subject. */
  project: z.string().optional(),
  failuresOnly: z.boolean().optional(),
  /** Inclusive lower bound on `time`. */
  from: z.iso.datetime().optional(),
  /** Exclusive upper bound on `time`. */
  to: z.iso.datetime().optional(),
  /** Case-insensitive text in the action, client, subjects, files written or error. */
  search: z.string().optional(),
});
export type ActivityFilter = z.infer<typeof ActivityFilter>;

export const ActivityQuery = ActivityFilter.extend({ limit: z.int().min(1).max(5_000).default(500) }).prefault({});
export type ActivityQuery = z.infer<typeof ActivityQuery>;

export const ActivityList = z.object({
  /** Newest first. */
  entries: z.array(ActivityEntry),
});
export type ActivityList = z.infer<typeof ActivityList>;

/** The JSON export of a filtered Activity view: every matching entry, newest first. */
export const ActivityExport = z.object({
  exportedAt: z.iso.datetime(),
  filter: ActivityFilter,
  entries: z.array(ActivityEntry),
});
export type ActivityExport = z.infer<typeof ActivityExport>;

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
  /** Agent-managed Skills it loads. */
  managedSkillCount: z.int().nonnegative().default(0),
  /** Its global MCP config file, home-relative; null for an Agent with no MCP surface (`.agents`). */
  mcpConfig: z.string().nullable().default(null),
  /** Global MCP Servers declared in that file. */
  globalMcpServerCount: z.int().nonnegative().default(0),
  /** Agent-managed MCP Servers it loads (#40). */
  managedMcpServerCount: z.int().nonnegative().default(0),
});
export type AgentScan = z.infer<typeof AgentScan>;

/**
 * A folder some Agent's history shows was worked in (#10), offered as a
 * Project. Never managed until you confirm it.
 */
export const SuggestedProject = z.object({
  /** Absolute: the git toplevel of the folder worked in, or the folder itself without git. */
  path: z.string(),
  name: z.string(),
  git: z.boolean(),
  /** The Agents whose history shows it. */
  agents: z.array(AgentId),
});
export type SuggestedProject = z.infer<typeof SuggestedProject>;

/** An entry with a `SKILL.md` in one of a Project's skill folders, as a Scan saw it (unclassified). */
export const ProjectSkillEntry = z.object({
  /** Frontmatter `name`, else the folder name. */
  name: z.string(),
  description: z.string(),
  /** The skill folder, relative to the Project, e.g. `.agents/skills`. */
  folder: z.string(),
  /** Absolute path of the entry. */
  path: z.string(),
  /** Absolute resolved real folder. */
  realPath: z.string(),
  symlink: z.boolean(),
  /** Git tracks it (the entry or its real folder in the Project): a Vendored Skill, never offered for Adopt. */
  tracked: z.boolean().default(false),
});
export type ProjectSkillEntry = z.infer<typeof ProjectSkillEntry>;

/** One confirmed Project's skill folders, as a Scan read them. */
export const ProjectScan = z.object({
  path: z.string(),
  exists: z.boolean(),
  /** Project-relative skill folders any v1 Agent loads, and whether each exists. */
  skillFolders: z.array(z.object({ path: z.string(), exists: z.boolean() })),
  skills: z.array(ProjectSkillEntry),
});
export type ProjectScan = z.infer<typeof ProjectScan>;

/** The Skills already in a Suggested Project (First run, #46): untracked ones and Vendored (`tracked`) ones. */
export const SuggestedProjectSkills = z.object({
  path: z.string(),
  name: z.string(),
  skills: z.array(ProjectSkillEntry),
});
export type SuggestedProjectSkills = z.infer<typeof SuggestedProjectSkills>;

/**
 * How an Agent-managed Skill can be turned off through its Agent's own global
 * settings. `skill` turns off just this Skill; `plugin` the whole plugin it
 * comes with; `bundled` every Skill bundled with the Agent.
 */
export const OffScope = z.enum(["skill", "plugin", "bundled"]);
export type OffScope = z.infer<typeof OffScope>;

export const OffSwitch = z.object({
  scope: OffScope,
  /** The config file it writes, home-relative. */
  file: z.string(),
  /** The setting it writes, as the user would read it in that file. */
  setting: z.string(),
});
export type OffSwitch = z.infer<typeof OffSwitch>;

/**
 * A Skill an Agent installs and controls itself (plugin, bundled, synced or
 * cached), found by a Scan. Dark Matter never moves it.
 */
export const ManagedSkill = z.object({
  /** Stable across Scans: `managed-skill:<agent>:<path>`. */
  id: z.string(),
  agent: AgentId,
  /** Frontmatter `name`, else the folder name. */
  name: z.string(),
  description: z.string(),
  /** Its folder, home-relative. */
  path: z.string(),
  kind: z.enum(["plugin", "bundled", "synced", "cached"]),
  /** The plugin it comes with, as the Agent names it (Claude Code: `plugin@marketplace`). */
  plugin: z.string().nullable(),
  /** Already turned off in the Agent's settings. */
  off: z.boolean(),
  /** Ways to turn it off, the narrowest first. Empty when the Agent has no off switch (Cursor). */
  offSwitches: z.array(OffSwitch),
});
export type ManagedSkill = z.infer<typeof ManagedSkill>;

/**
 * An Agent-neutral MCP Server definition (#37). String values may hold
 * references: `${env:VAR}` (an environment variable) and `${secret:NAME}` (a
 * Secret in the OS keychain). Adapters translate both into each Agent's syntax.
 */
export const McpDefinition = z.strictObject({
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpDefinition = z.infer<typeof McpDefinition>;

/** A Library MCP Server name: its file is `~/.dark-matter/mcp/<name>.json`. */
export const McpServerName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Use letters, digits, '.', '_' or '-' (up to 64)");

/** Where Adopt took an MCP Server from, so Undo Adopt can put the entry back. */
export const McpAdoptedFrom = z.strictObject({
  agent: AgentId,
  /** The Agent config file, home-relative. */
  file: z.string(),
  /** The key path of the entry in that file, e.g. `["mcpServers", "github"]`. */
  at: z.array(z.string()).min(1),
  /** The entry as the Agent wrote it, with each inline Secret replaced by `${secret:NAME}`. */
  entry: z.unknown(),
  /** The Project it came from, when it was put back there as Personal (#39); Undo releases it first. */
  project: z.string().optional(),
});
export type McpAdoptedFrom = z.infer<typeof McpAdoptedFrom>;

/** `~/.dark-matter/mcp/<name>.json`: one Library MCP Server, owned intent (ADR-0005). Holds Secret names only. */
export const McpServerFile = McpDefinition.extend({
  adoptedFrom: z.array(McpAdoptedFrom).optional(),
});
export type McpServerFile = z.infer<typeof McpServerFile>;

/** A Library MCP Server, as the MCP Servers screen lists it. */
export const LibraryMcpServer = z.object({
  name: z.string(),
  /** Null when the file doesn't validate (`problem` says why). */
  definition: McpDefinition.nullable(),
  /** Secret names it refers to. */
  secrets: z.array(z.string()),
  /** Those of its Secrets that aren't in the keychain yet. */
  missingSecrets: z.array(z.string()).default([]),
  adoptedFrom: z.array(McpAdoptedFrom.pick({ agent: true, file: true })),
  /** The file, home-relative. */
  file: z.string(),
  problem: z.string().nullable(),
});
export type LibraryMcpServer = z.infer<typeof LibraryMcpServer>;

export const LibraryMcpList = z.object({ servers: z.array(LibraryMcpServer) });
export type LibraryMcpList = z.infer<typeof LibraryMcpList>;

/** An MCP Server in an Agent's global config, found by a Scan. */
export const GlobalMcpServer = z.object({
  /** Stable across Scans: `global-mcp:<agent>:<name>`. */
  id: z.string(),
  agent: AgentId,
  name: z.string(),
  /** The config file, home-relative. */
  file: z.string(),
  /**
   * Its Agent-neutral definition. Inline secrets are already shown as
   * `${secret:<name>.<key>}`: their values never leave the core.
   */
  definition: McpDefinition,
  /** The env and header keys whose inline values Adopt moves into the keychain. */
  inlineSecrets: z.array(z.string()),
});
export type GlobalMcpServer = z.infer<typeof GlobalMcpServer>;

/**
 * How "Turn off everywhere" reaches an Agent-managed MCP Server (#40): `server`
 * turns off just this one, `plugin` the plugin it comes with, `connectors`
 * every claude.ai connector.
 */
export const McpOffScope = z.enum(["server", "plugin", "connectors"]);
export type McpOffScope = z.infer<typeof McpOffScope>;

export const McpOffSwitch = z.object({
  scope: McpOffScope,
  /** The config file it writes, home-relative. */
  file: z.string(),
  /** The setting it writes, as the user would read it in that file. */
  setting: z.string(),
});
export type McpOffSwitch = z.infer<typeof McpOffSwitch>;

/**
 * An MCP Server an Agent adds and controls itself (#40): a plugin's, a claude.ai
 * connector, a built-in, a marketplace or team server, or one from a system,
 * cloud or MDM config layer. Listed read-only; Dark Matter only ever turns one
 * off through the Agent's own documented global setting.
 */
export const ManagedMcpServer = z.object({
  /** Stable across Scans: `managed-mcp:<agent>:<name>`. */
  id: z.string(),
  agent: AgentId,
  /** The name the Agent shows, e.g. `plugin:figma:figma`. */
  name: z.string(),
  kind: z.enum(["plugin", "connector", "builtin", "marketplace", "team", "system", "managed"]),
  /** The plugin it comes with, as the Agent names it. */
  plugin: z.string().nullable(),
  /** The file that declares it (home-relative when under `$HOME`); null when it isn't in a file. */
  source: z.string().nullable(),
  /** Its definition with inline secrets masked; null when the Agent doesn't keep one on disk. */
  definition: McpDefinition.nullable(),
  /** Already off: turned off in the Agent's settings, or off until you opt in. */
  off: z.boolean(),
  /** Ways to turn it off everywhere, the narrowest first. Empty when it's read-only. */
  offSwitches: z.array(McpOffSwitch),
  /** Why it's read-only (and how to turn it off in the Agent), when there's no off switch. */
  readOnly: z.string().nullable(),
});
export type ManagedMcpServer = z.infer<typeof ManagedMcpServer>;

/** One Agent's Agent-managed MCP Servers, for the Inbox. */
export const InboxManagedMcpGroup = z.object({
  agent: AgentId,
  findings: z.array(ManagedMcpServer),
});
export type InboxManagedMcpGroup = z.infer<typeof InboxManagedMcpGroup>;

/** Global MCP Servers in one Agent config file, for the Inbox. */
export const InboxMcpGroup = z.object({
  agent: AgentId,
  file: z.string(),
  findings: z.array(GlobalMcpServer),
});
export type InboxMcpGroup = z.infer<typeof InboxMcpGroup>;

/** Everything one Scan found. Cached in `state/`; rebuilt by scanning again. */
export const ScanResult = z.object({
  scannedAt: z.iso.datetime(),
  agents: z.array(AgentScan),
  globalSkills: z.array(GlobalSkill),
  /** Every Project folder some Agent's history shows, confirmed and dismissed ones included. */
  suggestedProjects: z.array(SuggestedProject).default([]),
  /** What the Scan read in each confirmed Project's skill folders. */
  projects: z.array(ProjectScan).default([]),
  managedSkills: z.array(ManagedSkill).default([]),
  globalMcpServers: z.array(GlobalMcpServer).default([]),
  managedMcpServers: z.array(ManagedMcpServer).default([]),
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

/** One Agent's Agent-managed Skills, for the Inbox. */
export const InboxManagedGroup = z.object({
  agent: AgentId,
  findings: z.array(ManagedSkill),
});
export type InboxManagedGroup = z.infer<typeof InboxManagedGroup>;

/**
 * A Skill in a confirmed Project's skill folder that git doesn't track and
 * Dark Matter didn't deliver (#29). Adopt & keep Link moves it into the
 * Library and puts a Link back, On.
 */
export const UntrackedSkill = z.object({
  /** Stable across Scans: `untracked-skill:<realPath>`. */
  id: z.string(),
  /** The Project, absolute. */
  project: z.string(),
  name: z.string(),
  description: z.string(),
  /** Its resolved real folder, home-relative. */
  realPath: z.string(),
  /** Where the Project's Agents see it: `folder` is Project-relative, `path` home-relative. */
  locations: z.array(SkillLocation).min(1),
  /** Its real folder is outside the Project, so Adopt makes it a Local Source. */
  localSource: z.boolean(),
});
export type UntrackedSkill = z.infer<typeof UntrackedSkill>;

/** Untracked Skills in one Project, for the Inbox. */
export const InboxProjectGroup = z.object({
  project: z.string(),
  name: z.string(),
  findings: z.array(UntrackedSkill),
});
export type InboxProjectGroup = z.infer<typeof InboxProjectGroup>;

/**
 * Drift (#42): owned intent (`projects.json`) and the disk disagree.
 * "missing": a delivery was deleted by hand. "replaced": something else (e.g.
 * `npx skills`) took a delivery's place. "lockAdded" / "lockRemoved": a
 * teammate's `skills-lock.json` change added an entry that isn't a Project
 * Skill, or removed a Copy's entry. "projectGone": the Project's folder is gone.
 */
export const DriftKind = z.enum(["missing", "replaced", "lockAdded", "lockRemoved", "projectGone"]);
export type DriftKind = z.infer<typeof DriftKind>;

/** Restore re-applies owned intent; Accept updates `projects.json` to match disk. */
export const DriftAction = z.enum(["restore", "accept"]);
export type DriftAction = z.infer<typeof DriftAction>;

export const DriftFinding = z.object({
  /** `drift:<project>:<key>`, `drift:<project>:lock:<name>` or `drift:<project>`. */
  id: z.string(),
  kind: DriftKind,
  /** The Project, by absolute path. */
  project: z.string(),
  /** The Library key, when one is known. */
  key: z.string().nullable(),
  /** The delivered (or locked) name. */
  name: z.string().nullable(),
  /** Its delivery mode (`DeliveryMode`, declared further down). */
  mode: z.enum(["link", "copy"]).nullable(),
  /** Project-relative paths that drifted. */
  paths: z.array(z.string()),
  actions: z.array(DriftAction),
});
export type DriftFinding = z.infer<typeof DriftFinding>;

export const InboxDriftGroup = z.object({
  project: z.string(),
  name: z.string(),
  findings: z.array(DriftFinding),
});
export type InboxDriftGroup = z.infer<typeof InboxDriftGroup>;

/** A Skill folder a starred Source gained since it was last checked, not yet in the Library (#35). */
export const NewSkillFinding = z.object({
  /** `new-skill:<owner/repo>:<path>`. */
  id: z.string(),
  source: z.string(),
  /** The folder in the repo (`.` = the root). */
  path: z.string(),
  /** The folder's name (the repo's for the root). */
  name: z.string(),
  /** When a check first found it. */
  foundAt: z.iso.datetime(),
});
export type NewSkillFinding = z.infer<typeof NewSkillFinding>;

/** "New Skills in ⭐ owner/repo". */
export const InboxNewSkillsGroup = z.object({
  source: z.string(),
  findings: z.array(NewSkillFinding),
});
export type InboxNewSkillsGroup = z.infer<typeof InboxNewSkillsGroup>;

/** Findings still waiting on a decision. Ignored findings are left out. */
export const Inbox = z.object({
  /** The badge: findings waiting, across every kind. */
  count: z.int().nonnegative(),
  globalSkills: z.array(InboxFolderGroup),
  /** Agent-managed Skills that are still on, by Agent. */
  managedSkills: z.array(InboxManagedGroup),
  /** Untracked Project Skills, by Project (#29). */
  untrackedSkills: z.array(InboxProjectGroup).default([]),
  ignoredCount: z.int().nonnegative(),
  /** Suggested Projects waiting to be confirmed or dismissed (listed on the Suggested screen). */
  suggestedProjects: z.int().nonnegative(),
  /** Global MCP Servers, by Agent config file. */
  mcpServers: z.array(InboxMcpGroup).default([]),
  /** Pending Requests from Agents and the CLI, oldest first (#44). Counted. */
  requests: z.array(PendingRequest).default([]),
  /** Drift between `projects.json` and the disk, by Project (#42). */
  drift: z.array(InboxDriftGroup).default([]),
  /** Agent-managed MCP Servers that are still on, by Agent. */
  managedMcpServers: z.array(InboxManagedMcpGroup).default([]),
  /** New Skills in starred Sources, by Source (#35). Never Imported on their own. */
  newSkills: z.array(InboxNewSkillsGroup).default([]),
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
  /** Null until the first Scan. */
  managedSkillCount: z.int().nonnegative().nullable(),
  /** Its global MCP config file, home-relative; null when the Agent has no MCP surface. */
  mcpConfig: z.string().nullable().default(null),
  /** Null until the first Scan, or when the Agent has no MCP surface. */
  globalMcpServerCount: z.int().nonnegative().nullable().default(null),
  /** Agent-managed MCP Servers; null until the first Scan, or when the Agent has no MCP surface. */
  managedMcpServerCount: z.int().nonnegative().nullable().default(null),
  /** Agent-managed MCP Servers Dark Matter can't list from disk, and why (e.g. Cursor team servers). */
  managedMcpNotes: z.array(z.string()).default([]),
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
  /** Remove a real folder Dark Matter wrote, e.g. a Copy turned Off (#28). Never a symlink. */
  z.object({ kind: z.literal("removeFolder"), path: z.string() }),
  /** Rewrite an owned or foreign file, e.g. `library-lock.json` or the `skills` CLI's global lock. */
  z.object({ kind: z.literal("editFile"), path: z.string(), change: z.string(), backup: z.string().optional() }),
  /** Store a Secret's value in the OS keychain under `name` (the value never appears in a plan). */
  z.object({ kind: z.literal("storeSecret"), name: z.string() }),
  /** Delete a Secret from the OS keychain once nothing refers to it. */
  z.object({ kind: z.literal("deleteSecret"), name: z.string() }),
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
/** A Namespace: `local`, or `owner/repo` like a GitHub Source. */
export const NamespaceName = z.string().regex(/^(local|[\w.-]+\/[\w.-]+)$/, "A Namespace is local or owner/repo");

/** A Library Skill's key before and after a change such as Rename Namespace. */
export const KeyRename = z.object({ from: z.string(), to: z.string() });
export type KeyRename = z.infer<typeof KeyRename>;

export const RenameNamespaceInput = z
  .object({ from: NamespaceName, to: NamespaceName })
  .refine((input) => input.from !== input.to, {
    message: "The new Namespace is the same as the old one",
    path: ["to"],
  });
export type RenameNamespaceInput = z.infer<typeof RenameNamespaceInput>;

export const ApplyRenameNamespaceInput = z.object({ from: NamespaceName, to: NamespaceName, planId: z.string() });
export type ApplyRenameNamespaceInput = z.infer<typeof ApplyRenameNamespaceInput>;

/** Rename Namespace's dry run: every Skill's new key, the folder moves, and Links to re-create (#27). */
export const RenameNamespacePlan = PlanBase.extend({
  from: z.string(),
  to: z.string(),
  renames: z.array(KeyRename),
});
export type RenameNamespacePlan = z.infer<typeof RenameNamespacePlan>;

/** When the daily Scheduled Scan runs. */
export const SchedulerStatus = z.object({
  /** The Scheduled Scan time, local `HH:MM`. */
  time: z.string(),
  /** The next run, or null until a Scan has ever run (the First run asks first). */
  nextRunAt: z.iso.datetime().nullable(),
  /** When the last Scheduled Scan started; null before the first. */
  lastRunAt: z.iso.datetime().nullable(),
});
export type SchedulerStatus = z.infer<typeof SchedulerStatus>;

/** An OS notification the core asks the app to show, over the `notifications` subscription (Electron main shows it). */
export const CoreNotification = z.object({
  title: z.string(),
  body: z.string(),
  /** The screen to open when it's clicked, e.g. `/inbox`. */
  path: z.string(),
  /** A pending Request (#44): the notification offers Approve and Deny for it. */
  request: z.string().optional(),
});
export type CoreNotification = z.infer<typeof CoreNotification>;

/** Router domains a client caches; an `invalidate` event names the ones that changed. */
export const Domain = z.enum([
  "core",
  "library",
  "settings",
  "ownedFiles",
  "activity",
  "scan",
  "inbox",
  "overview",
  "agents",
  "scheduler",
  "project",
  "mcp",
  "skill",
  "collections",
  "importer",
  "favourites",
  "requests",
]);
export type Domain = z.infer<typeof Domain>;

/** Pushed over the `events` subscription to drive TanStack Query invalidation. */
export const CoreEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("invalidate"), domains: z.array(Domain).min(1) }),
]);
export type CoreEvent = z.infer<typeof CoreEvent>;

/**
 * One Project in `projects.json`. Owned intent only (ADR-0005): later tickets
 * add Project Skills (#27), Project MCP Servers (#38) and the Grant as fields
 * with defaults, so older files stay valid.
 */
/** How a Project Skill reaches the Project's Agents: a personal Link or a committed Copy (#28). */
export const DeliveryMode = z.enum(["link", "copy"]);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

/** One Project Skill in `projects.json`: owned intent, keyed by Library key. Off keeps it here, undelivered. */
export const ProjectSkillRecord = z.strictObject({
  mode: DeliveryMode,
  on: z.boolean(),
});
export type ProjectSkillRecord = z.infer<typeof ProjectSkillRecord>;

/**
 * How a Project MCP Server reaches the Project's Agents: "personal" (never
 * committed, real Secrets) or "shared" (#39: committed config, env references only).
 */
export const McpDeliveryMode = z.enum(["personal", "shared"]);
export type McpDeliveryMode = z.infer<typeof McpDeliveryMode>;

/** One entry Dark Matter wrote for a Project MCP Server: how it tells its own entries apart. */
export const McpDelivered = z.strictObject({
  agent: AgentId,
  /** The config file, home-relative. */
  file: z.string(),
  /** The entry's key path in that file, e.g. `["mcpServers", "github"]`. */
  at: z.array(z.string()).min(1),
  /**
   * Shared only (#39): a hash of the entry as Dark Matter wrote it, so a hand
   * edit in the repo shows as "modified in repo" instead of being overwritten.
   */
  written: z.string().optional(),
  /**
   * Personal only (story 104): a hash of the entry as Dark Matter wrote it (never
   * the Secret value), so a hand edit shows as "modified" instead of being overwritten.
   */
  hash: z.string().optional(),
});
export type McpDelivered = z.infer<typeof McpDelivered>;

/**
 * One Project MCP Server in `projects.json`, keyed by Library name. Off keeps
 * its mode here with nothing delivered; Agents stay Project-level.
 */
export const ProjectMcpServerRecord = z.strictObject({
  mode: McpDeliveryMode,
  on: z.boolean(),
  /** The entries written now; empty when Off. */
  delivered: z.array(McpDelivered).default([]),
});
export type ProjectMcpServerRecord = z.infer<typeof ProjectMcpServerRecord>;

export const ProjectRecord = z.strictObject({
  /** The Agents chosen for this Project; they decide which folders get written. */
  agents: z.array(AgentId).default([]),
  /** Project Skills by Library key (#27). */
  skills: z.record(z.string(), ProjectSkillRecord).default({}),
  /** Project MCP Servers by Library name (#38). Left out while there are none. */
  mcpServers: z.record(z.string(), ProjectMcpServerRecord).optional(),
  /** The Grant (#44): Agents' low-risk Requests here go through without asking. Left out while off. */
  grant: z.literal(true).optional(),
});
export type ProjectRecord = z.infer<typeof ProjectRecord>;

/** `~/.dark-matter/projects.json`: confirmed Projects keyed by absolute path. */
export const ProjectsFile = z.strictObject({
  projects: z.record(z.string(), ProjectRecord).default({}),
});
export type ProjectsFile = z.infer<typeof ProjectsFile>;

export const SuggestedProjects = z.object({
  /** Not confirmed and not dismissed, by name. */
  suggested: z.array(SuggestedProject),
  dismissedCount: z.int().nonnegative(),
});
export type SuggestedProjects = z.infer<typeof SuggestedProjects>;

/** A confirmed Project, as the sidebar lists it. */
export const ProjectSummary = z.object({
  path: z.string(),
  name: z.string(),
  /** False when the folder is gone: the Project page offers Locate… or Remove. */
  exists: z.boolean(),
  agents: z.array(AgentId),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

/** One choice in a Project's Agent picker. */
export const ProjectAgentOption = z.object({
  id: AgentId,
  name: z.string(),
  /** Its history shows this Project, or its marker (e.g. `.claude/`) is in the folder. */
  detected: z.boolean(),
  /** The Project folder Project Skills reach this Agent through, e.g. `.agents/skills`. */
  folder: z.string(),
});
export type ProjectAgentOption = z.infer<typeof ProjectAgentOption>;

export const ProjectDetail = ProjectSummary.extend({
  git: z.boolean(),
  agentOptions: z.array(ProjectAgentOption),
  /** The Project-relative folders Dark Matter writes for the chosen Agents. */
  folders: z.array(z.string()),
  /** Skills the last Scan saw in its skill folders; null before a Scan has read it. */
  skills: z.array(ProjectSkillEntry).nullable(),
  /** Its Grant (#44): On/Off and adding or removing a Link go through without asking. */
  grant: z.boolean().optional(),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

export const ProjectPath = z.object({ path: z.string().min(1) });

/** Exit codes of the core process, so a supervisor can tell why it stopped. */
export const CoreExitCode = {
  /** Another core holds `core.lock`: attach to it instead. */
  locked: 75,
  failed: 1,
} as const;

export const CopyState = z.enum(["current", "outdated", "modifiedInRepo"]);
export type CopyState = z.infer<typeof CopyState>;

/** What Adopt does with one MCP Server: as with Skills, minus Local Sources. */
export const McpAdoptOutcome = AdoptOutcome.exclude(["localSource"]);
export type McpAdoptOutcome = z.infer<typeof McpAdoptOutcome>;

export const McpAdoptPlanServer = z.object({
  finding: z.string(),
  agent: AgentId,
  /** Its name in the Agent's config. */
  name: z.string(),
  /** The Library MCP Server it ends up as. */
  libraryName: z.string(),
  outcome: McpAdoptOutcome,
  /** Secret names it stores in the keychain. */
  secrets: z.array(z.string()),
  /** For a variant: the Library MCP Server of the same name it differs from, and how. */
  diff: SkillDiff.nullable(),
});
export type McpAdoptPlanServer = z.infer<typeof McpAdoptPlanServer>;

export const McpAdoptPlan = PlanBase.extend({
  findings: z.array(z.string()),
  servers: z.array(McpAdoptPlanServer),
});
export type McpAdoptPlan = z.infer<typeof McpAdoptPlan>;

export const McpAdoptInput = z.object({
  findings: z.array(z.string().min(1)).min(1),
  /** Names you chose for variants, by finding id. Others get a suggested `<name>-<agent>`. */
  names: z.record(z.string(), McpServerName).optional(),
});
export type McpAdoptInput = z.infer<typeof McpAdoptInput>;

export const ApplyMcpAdoptInput = McpAdoptInput.extend({ planId: z.string() });
export type ApplyMcpAdoptInput = z.infer<typeof ApplyMcpAdoptInput>;
/**
 * A Project Skill as the Project page and the Skill page show it.
 * `status`: "on" (delivered), "off", or "nameConflict" (another Project Skill
 * with the same name wants the same Agent folders: Resolve, switch disabled).
 */
export const ProjectSkill = z.object({
  key: z.string(),
  namespace: z.string(),
  /** The folder name it's delivered under: its SKILL.md `name`. */
  name: z.string(),
  mode: DeliveryMode,
  on: z.boolean(),
  status: z.enum(["on", "off", "nameConflict"]),
  /** The other Library keys with the same name in this Project. */
  conflictsWith: z.array(z.string()),
  /** Project-relative paths it is (or would be) delivered at. */
  paths: z.array(z.string()),
  /**
   * A delivered Copy against its `skills-lock.json` entry and the Library (#28):
   * "current", "outdated" (the Library moved on: Update) or "modifiedInRepo"
   * (its files were edited: Diff, Pull into Library). Absent for a Link or an Off Copy.
   */
  copyState: CopyState.optional(),
});
export type ProjectSkill = z.infer<typeof ProjectSkill>;

/** One Project Skill to add; `mode` defaults to Link. */
export const AddProjectSkill = ProjectPath.extend({ key: z.string().min(1), mode: DeliveryMode.optional() });
export type AddProjectSkill = z.infer<typeof AddProjectSkill>;

export const AddProjectSkills = z.object({ skills: z.array(AddProjectSkill).min(1) });
export type AddProjectSkills = z.infer<typeof AddProjectSkills>;

/** A Project's Project Skills after a change. */
export const ProjectSkills = z.object({ path: z.string(), skills: z.array(ProjectSkill) });
export type ProjectSkills = z.infer<typeof ProjectSkills>;

/** One Project using a Library Skill, for the Skill page's Projects tab. */
export const SkillProjectUse = ProjectSkill.extend({ path: z.string(), projectName: z.string() });
export type SkillProjectUse = z.infer<typeof SkillProjectUse>;

export const ProjectSkillRef = ProjectPath.extend({ key: z.string().min(1) });
export type ProjectSkillRef = z.infer<typeof ProjectSkillRef>;

/**
 * A change that may replace or delete a Copy's files (#28). A Copy "modified
 * in repo" is refused (`CopyModifiedInRepo`) unless `discardEdits` says you were asked.
 */
export const ProjectSkillChange = ProjectSkillRef.extend({ discardEdits: z.boolean().optional() });
export type ProjectSkillChange = z.infer<typeof ProjectSkillChange>;

/** A committed Skill in a Project that Dark Matter didn't create as a Copy: shown, never changed (#28). */
export const VendoredSkill = z.object({
  name: z.string(),
  description: z.string(),
  /** Project-relative entries that are this Skill (a folder and the symlinks to it). */
  paths: z.array(z.string()),
});
export type VendoredSkill = z.infer<typeof VendoredSkill>;

/** An entry in the Project's `skills-lock.json` that isn't one of its Project Skills yet: a wanted Skill to fulfil. */
export const LockedSkill = z.object({
  /** The installed name: the lock key and the folder under `.agents/skills`. */
  name: z.string(),
  source: z.string(),
  sourceType: z.string(),
  /** The Library Skill that fulfils it, or null when it isn't in the Library. */
  key: z.string().nullable(),
  /** Its folder is already in `.agents/skills` (kept as is when fulfilled). */
  present: z.boolean(),
  /** Why it can't be fulfilled now, e.g. not in the Library and no Import yet; null when it can. */
  message: z.string().nullable(),
});
export type LockedSkill = z.infer<typeof LockedSkill>;

export const RepoSkills = z.object({
  vendored: z.array(VendoredSkill),
  locked: z.array(LockedSkill),
});
export type RepoSkills = z.infer<typeof RepoSkills>;

export const FulfilLockInput = ProjectPath.extend({ names: z.array(z.string().min(1)).min(1) });
export type FulfilLockInput = z.infer<typeof FulfilLockInput>;

/** A Copy's files against its Library Skill, as a unified diff (`a` = Library, `b` = the repo). Empty when they match. */
export const CopyDiff = z.object({ patch: z.string() });
export type CopyDiff = z.infer<typeof CopyDiff>;

/** A Collection item as Collections list it: `missing` when its Library Skill or MCP Server is gone (deleted or never there). */
export const CollectionItemView = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skill"), key: z.string(), name: z.string(), missing: z.boolean() }),
  z.object({ kind: z.literal("mcpServer"), name: z.string(), missing: z.boolean() }),
]);
export type CollectionItemView = z.infer<typeof CollectionItemView>;

export const Collection = z.object({ name: z.string(), items: z.array(CollectionItemView) });
export type Collection = z.infer<typeof Collection>;

export const CreateCollectionInput = z.object({ name: CollectionName, items: z.array(CollectionItem).default([]) });
export type CreateCollectionInput = z.infer<typeof CreateCollectionInput>;

export const RenameCollectionInput = z.object({ name: z.string().min(1), newName: CollectionName });
export type RenameCollectionInput = z.infer<typeof RenameCollectionInput>;

export const SetCollectionItemsInput = z.object({ name: z.string().min(1), items: z.array(CollectionItem) });
export type SetCollectionItemsInput = z.infer<typeof SetCollectionItemsInput>;

/** Which Projects to add a Collection to, and Link or Copy per Skill (Link when left out). */
export const CollectionPlanInput = z.object({
  name: z.string().min(1),
  projects: z.array(z.string().min(1)).min(1),
  modes: z.record(z.string(), DeliveryMode).optional(),
  /** Personal or Shared per MCP Server (#41), by name; Personal when left out. */
  mcpModes: z.record(z.string(), McpDeliveryMode).optional(),
});
export type CollectionPlanInput = z.infer<typeof CollectionPlanInput>;

/**
 * What adding one Collection item to one Project does:
 * - "add": it becomes an ordinary Project Skill, delivered On;
 * - "present": the Project already has it (left as it is);
 * - "nameConflict": another Project Skill (or another item) has its name; it's added in a Name Conflict to Resolve;
 * - "blocked": something Dark Matter didn't put there holds its folder (`path`), so it can't be added;
 * - "missing": its Library Skill is gone.
 */
export const CollectionCellOutcome = z.enum(["add", "present", "nameConflict", "blocked", "missing"]);
export type CollectionCellOutcome = z.infer<typeof CollectionCellOutcome>;

export const CollectionCell = z.object({
  path: z.string(),
  key: z.string(),
  mode: DeliveryMode,
  outcome: CollectionCellOutcome,
  /** For "nameConflict": the other Library keys with the same name. */
  conflictsWith: z.array(z.string()),
  /** For "blocked": the Project-relative path in the way. */
  blockedBy: z.string().nullable(),
});
export type CollectionCell = z.infer<typeof CollectionCell>;

/**
 * One Agent's delivery of a Project MCP Server: "delivered" (its entry is
 * written), "off", "tracked" (its Project config file is committed, so
 * Personal isn't offered for that Agent), and for Shared (#39) "outdated" (the
 * Library definition changed: Update) or "modifiedInRepo" (hand-edited: Take
 * Library version or Pull into Library).
 */
export const McpDeliveryStatus = z.object({
  agent: AgentId,
  /** The config file, home-relative. */
  file: z.string(),
  /** `modified`: a Personal entry edited by hand since Dark Matter wrote it (story 104). */
  status: z.enum(["delivered", "off", "tracked", "outdated", "modifiedInRepo", "modified"]),
  /**
   * The Agent's own gate on a written entry (#39), when it has one: "approved",
   * "needsApproval" (Cursor; Claude Code when Dark Matter couldn't record it),
   * or "untrusted" (Codex: delivered, inactive until the Project is trusted).
   */
  approval: z.enum(["approved", "needsApproval", "untrusted"]).optional(),
});
export type McpDeliveryStatus = z.infer<typeof McpDeliveryStatus>;

/** A Project MCP Server as the Project page shows it. */
export const ProjectMcpServer = z.object({
  name: z.string(),
  mode: McpDeliveryMode,
  on: z.boolean(),
  /** Secret names its definition refers to. */
  secrets: z.array(z.string()),
  /** One per chosen Agent with an MCP surface (never `.agents`). */
  deliveries: z.array(McpDeliveryStatus),
  /** Shared only (#39): the environment variables each teammate must set. */
  envVars: z.array(z.string()).optional(),
});
export type ProjectMcpServer = z.infer<typeof ProjectMcpServer>;

export const ProjectMcpServers = z.object({ path: z.string(), servers: z.array(ProjectMcpServer) });
export type ProjectMcpServers = z.infer<typeof ProjectMcpServers>;

/** One Project MCP Server to add; `mode` defaults to Personal. */
export const AddProjectMcpServer = ProjectPath.extend({ name: McpServerName, mode: McpDeliveryMode.optional() });
export type AddProjectMcpServer = z.infer<typeof AddProjectMcpServer>;

export const AddProjectMcpServers = z.object({ servers: z.array(AddProjectMcpServer).min(1) });
export type AddProjectMcpServers = z.infer<typeof AddProjectMcpServers>;

export const ProjectMcpServerRef = ProjectPath.extend({ name: McpServerName });
export type ProjectMcpServerRef = z.infer<typeof ProjectMcpServerRef>;

/**
 * Where Personal would write for each of a Project's Agents, and whether it's
 * offered (not tracked by git); `shared` is the committed file Shared writes (#39).
 */
export const McpTarget = z.object({ agent: AgentId, file: z.string(), personal: z.boolean(), shared: z.string() });
export type McpTarget = z.infer<typeof McpTarget>;

/** A Secret's new value (entered or rotated). It goes straight into the keychain. */
export const SetSecretInput = z.object({ name: z.string().min(1), value: z.string().min(1) });
export type SetSecretInput = z.infer<typeof SetSecretInput>;

export const UpdateMcpDefinitionInput = z.object({ name: McpServerName, definition: McpDefinition });
export type UpdateMcpDefinitionInput = z.infer<typeof UpdateMcpDefinitionInput>;

/**
 * What adding one Collection MCP Server to one Project does (#41): "add" (a
 * Project MCP Server, delivered On), "present", "blocked" (it can't be
 * delivered: a name taken in a config file, `blockedBy`, or another
 * `problem` such as a Secret not in the keychain yet) or "missing".
 */
export const CollectionMcpCell = z.object({
  path: z.string(),
  name: z.string(),
  mode: McpDeliveryMode,
  outcome: z.enum(["add", "present", "blocked", "missing"]),
  /** For a Name Conflict: the config file and entry in the way, as `<~file> › <at>`. */
  blockedBy: z.string().nullable(),
  /** For "blocked": why, in words. */
  problem: z.string().nullable(),
});
export type CollectionMcpCell = z.infer<typeof CollectionMcpCell>;

export const CollectionPlan = z.object({
  name: z.string(),
  cells: z.array(CollectionCell),
  mcpCells: z.array(CollectionMcpCell),
});
export type CollectionPlan = z.infer<typeof CollectionPlan>;

/** Applying a Collection: the cells you ticked, each with Link or Copy. Blocked ones are skipped and reported. */
export const ApplyCollectionInput = z
  .object({
    name: z.string().min(1),
    skills: z.array(AddProjectSkill).default([]),
    mcpServers: z.array(AddProjectMcpServer).default([]),
  })
  .refine((input) => input.skills.length + input.mcpServers.length > 0, "Pick at least one item");
export type ApplyCollectionInput = z.infer<typeof ApplyCollectionInput>;

export const AppliedCollection = z.object({
  /** Each touched Project's Project Skills afterwards. */
  projects: z.array(ProjectSkills),
  /** Per item and Project, what happened. */
  cells: z.array(CollectionCell),
  /** Each touched Project's MCP Servers afterwards (#41). */
  mcpProjects: z.array(ProjectMcpServers),
  mcpCells: z.array(CollectionMcpCell),
});
export type AppliedCollection = z.infer<typeof AppliedCollection>;

/** Turning a Project MCP Server On or Off; `discardEdits` confirms dropping a Shared entry modified in repo (#39). */
export const SetProjectMcpServerOn = ProjectMcpServerRef.extend({
  on: z.boolean(),
  discardEdits: z.boolean().optional(),
});
export type SetProjectMcpServerOn = z.infer<typeof SetProjectMcpServerOn>;

export const RemoveProjectMcpServer = ProjectMcpServerRef.extend({ discardEdits: z.boolean().optional() });
export type RemoveProjectMcpServer = z.infer<typeof RemoveProjectMcpServer>;

export const SetProjectMcpServerMode = ProjectMcpServerRef.extend({
  mode: McpDeliveryMode,
  discardEdits: z.boolean().optional(),
});
export type SetProjectMcpServerMode = z.infer<typeof SetProjectMcpServerMode>;

/** Update a Shared delivery to the Library version; `discardEdits` confirms dropping an edit made in the repo. */
export const UpdateProjectMcpServer = ProjectMcpServerRef.extend({ discardEdits: z.boolean().optional() });
export type UpdateProjectMcpServer = z.infer<typeof UpdateProjectMcpServer>;

/** Pull one Agent's hand-edited Shared entry back into the Library definition. */
export const PullProjectMcpServer = ProjectMcpServerRef.extend({ agent: AgentId });
export type PullProjectMcpServer = z.infer<typeof PullProjectMcpServer>;

/**
 * A change to one Project MCP Server to dry-run (#39): add it or change its
 * mode (`mode`), On/Off (`on`), `remove` it, or `update` a Shared delivery.
 * Left out, `mode` and `on` keep what the Project has (Personal and On for a new one).
 */
export const McpChangeInput = ProjectMcpServerRef.extend({
  mode: McpDeliveryMode.optional(),
  on: z.boolean().optional(),
  remove: z.boolean().optional(),
  update: z.boolean().optional(),
  discardEdits: z.boolean().optional(),
});
export type McpChangeInput = z.infer<typeof McpChangeInput>;

/** What a change would write, before anything is written. */
export const McpChangePlan = z.object({
  edits: z.array(z.object({ file: z.string(), change: z.string() })),
  /** The env vars teammates must set for it (Shared), else empty. */
  envVars: z.array(z.string()),
  /** It edits a committed (Shared) config file: everyone on the team gets the change. */
  teamChange: z.boolean(),
});
export type McpChangePlan = z.infer<typeof McpChangePlan>;

/**
 * An MCP Server entry already in a Project's config that Dark Matter didn't
 * write (#39): Vendored when its file is tracked by git (shown, left alone),
 * else untracked (or Claude Code local scope), which Adopt moves into the
 * Library and puts back as Personal. The id is the Adopt finding id.
 */
export const RepoMcpServer = z.object({
  /** `project-mcp:<agent>:<project path>:<name>`. */
  id: z.string(),
  agent: AgentId,
  name: z.string(),
  /** The config file, home-relative. */
  file: z.string(),
  /** Inline secrets masked as `${secret:…}`. */
  definition: McpDefinition,
});
export type RepoMcpServer = z.infer<typeof RepoMcpServer>;

export const RepoMcpServers = z.object({ vendored: z.array(RepoMcpServer), untracked: z.array(RepoMcpServer) });
export type RepoMcpServers = z.infer<typeof RepoMcpServers>;

/** One stat card on an overview screen (#45): its number (null before the first Scan) and the screen that resolves it. */
export const StatCard = z.object({ count: z.int().nonnegative().nullable(), path: z.string() });
export type StatCard = z.infer<typeof StatCard>;

/**
 * One item in the amber alerts panel (#45): an Inbox group or a drift finding,
 * as a bold subject plus the issue, a detail line, when it was first seen and
 * the screen that resolves it.
 */
export const OverviewAlert = z.object({
  id: z.string(),
  subject: z.string(),
  issue: z.string(),
  detail: z.string(),
  firstSeenAt: z.iso.datetime(),
  path: z.string(),
});
export type OverviewAlert = z.infer<typeof OverviewAlert>;

/** The stat-card strip and alerts panel, from one place so every overview screen agrees. */
export const Overview = z.object({
  stats: z.object({
    projectSkillsOn: StatCard,
    globalSkills: StatCard,
    outdated: StatCard,
    nameConflicts: StatCard,
  }),
  alerts: z.array(OverviewAlert),
});
export type Overview = z.infer<typeof Overview>;

/** A Project MCP Server entry in one config file (home-relative). */
export const McpEntryRef = z.object({ name: z.string(), file: z.string() });
export type McpEntryRef = z.infer<typeof McpEntryRef>;

/**
 * What removing a Project does (review #5): Dark Matter's own deliveries go
 * (Links and Personal MCP entries); committed ones (Copies, Shared entries)
 * stay in the repo for the team and become Vendored. Paths are Project-relative.
 */
export const ProjectRemovePlan = z.object({
  path: z.string(),
  links: z.array(z.string()),
  personalMcpServers: z.array(McpEntryRef),
  keptCopies: z.array(z.string()),
  keptSharedMcpServers: z.array(McpEntryRef),
});
export type ProjectRemovePlan = z.infer<typeof ProjectRemovePlan>;

/** Undo Adopt's dry run: the Projects whose Links to the Skill are removed first (Copies stay as committed files). */
export const UndoAdoptPlan = z.object({
  key: z.string(),
  /** Where the Skill moves back to, home-relative. */
  adoptedFrom: z.string(),
  projects: z.array(SkillDeleteImpact),
});
export type UndoAdoptPlan = z.infer<typeof UndoAdoptPlan>;
