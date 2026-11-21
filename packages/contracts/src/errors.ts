/**
 * The tagged-error convention (ADR-0004): every expected failure is an Error
 * with a stable string `_tag`. tRPC responses carry the tag in `error.data.tag`.
 */
export abstract class TaggedError<Tag extends string> extends Error {
  abstract readonly _tag: Tag;
}

export const isTaggedError = (value: unknown): value is TaggedError<string> =>
  value instanceof Error && typeof (value as { _tag?: unknown })._tag === "string";

/** A connection that didn't present the token from `core.json`. */
export class Unauthorized extends TaggedError<"Unauthorized"> {
  readonly _tag = "Unauthorized";
  constructor() {
    super("Connection rejected: missing or wrong core token");
  }
}

/** Another core already holds `core.lock` for this Library. */
export class CoreLocked extends TaggedError<"CoreLocked"> {
  readonly _tag = "CoreLocked";
  constructor(
    readonly lockPath: string,
    readonly holderPid: number,
  ) {
    super(`Another core (pid ${holderPid}) holds ${lockPath}`);
  }
}

/** An owned file holds a hand edit that doesn't validate, so the core won't write it (ADR-0005). */
export class InvalidOwnedFile extends TaggedError<"InvalidOwnedFile"> {
  readonly _tag = "InvalidOwnedFile";
  constructor(
    readonly path: string,
    readonly problem: string,
  ) {
    super(`${path} has a hand edit that isn't valid: ${problem}. Fix it or discard it first.`);
  }
}

/** No confirmed Project has this path. */
export class ProjectNotFound extends TaggedError<"ProjectNotFound"> {
  readonly _tag = "ProjectNotFound";
  constructor(readonly path: string) {
    super(`${path} isn't a Project`);
  }
}

/** A folder Dark Matter was asked to use isn't there (any more). */
export class PathGone extends TaggedError<"PathGone"> {
  readonly _tag = "PathGone";
  constructor(readonly path: string) {
    super(`${path} doesn't exist or isn't a folder`);
  }
}

/** Another confirmed Project already has this path. */
export class ProjectExists extends TaggedError<"ProjectExists"> {
  readonly _tag = "ProjectExists";
  constructor(readonly path: string) {
    super(`${path} is already a Project`);
  }
}

/** An Agent's config file doesn't parse, so the core won't edit it. */
export class InvalidAgentConfig extends TaggedError<"InvalidAgentConfig"> {
  readonly _tag = "InvalidAgentConfig";
  constructor(
    readonly path: string,
    readonly problem: string,
  ) {
    super(`${path} doesn't parse (${problem}), so Dark Matter won't edit it. Fix it first.`);
  }
}

/** A finding id that the latest Scan doesn't know, or an action it doesn't offer. */
export class UnknownFinding extends TaggedError<"UnknownFinding"> {
  readonly _tag = "UnknownFinding";
  constructor(readonly id: string) {
    super(`No finding ${id} in the latest Scan offers that action`);
  }
}

/** A plan changed between its dry run and apply (the disk or the Scan moved on). Plan again. */
export class PlanStale extends TaggedError<"PlanStale"> {
  readonly _tag = "PlanStale";
  constructor() {
    super("Things changed since this plan was made. Review the new plan and apply it again.");
  }
}

/** A finding id that the latest Scan doesn't have (gone, already Adopted, or never seen). */
export class FindingNotFound extends TaggedError<"FindingNotFound"> {
  readonly _tag = "FindingNotFound";
  constructor(readonly id: string) {
    super(`No finding ${id} in the latest Scan. Scan again.`);
  }
}

/** A Library Skill key that isn't in the Library Lock. */
export class SkillNotFound extends TaggedError<"SkillNotFound"> {
  readonly _tag = "SkillNotFound";
  constructor(readonly key: string) {
    super(`No Library Skill ${key}`);
  }
}

/** Undo Adopt on a Library Skill that wasn't Adopted. */
export class NotAdopted extends TaggedError<"NotAdopted"> {
  readonly _tag = "NotAdopted";
  constructor(readonly key: string) {
    super(`${key} wasn't Adopted, so there's nowhere to move it back to`);
  }
}

/** Something already sits where a move or link would go; nothing is overwritten. */
export class PathTaken extends TaggedError<"PathTaken"> {
  readonly _tag = "PathTaken";
  constructor(readonly path: string) {
    super(`${path} already exists; move it aside first`);
  }
}

/**
 * A Name Conflict: a name is already taken where Dark Matter would put a Skill.
 * Either a Namespace rename would put two Library Skills under one key (`keys`),
 * or a Project Skill can't be delivered because `path` in an Agent folder is
 * taken by another Project Skill (Resolve first) or by something Dark Matter
 * didn't put there. Nothing is overwritten.
 */
export class NameConflict extends TaggedError<"NameConflict"> {
  readonly _tag = "NameConflict";
  constructor(
    readonly keys: string[],
    readonly path?: string,
  ) {
    super(
      path === undefined
        ? `${keys.join(", ")} already ${keys.length === 1 ? "exists" : "exist"} in the Library`
        : `${keys.join(", ")} can't be delivered: ${path} is already taken`,
    );
  }
}

/** No Library Skill is in this Namespace. */
export class NamespaceNotFound extends TaggedError<"NamespaceNotFound"> {
  readonly _tag = "NamespaceNotFound";
  constructor(readonly namespace: string) {
    super(`No Library Skills in the Namespace ${namespace}`);
  }
}

/** A path that isn't a file inside the Skill's folder (missing, a folder, or outside it). */
export class SkillFileNotFound extends TaggedError<"SkillFileNotFound"> {
  readonly _tag = "SkillFileNotFound";
  constructor(
    readonly key: string,
    readonly path: string,
  ) {
    super(`${key} has no file ${path}`);
  }
}

/** The Project hasn't added this Library Skill. */
export class ProjectSkillNotFound extends TaggedError<"ProjectSkillNotFound"> {
  readonly _tag = "ProjectSkillNotFound";
  constructor(
    readonly path: string,
    readonly key: string,
  ) {
    super(`${path} has no Project Skill ${key}`);
  }
}

/** A Project's `skills-lock.json` can't be read (bad JSON, merge markers, no `skills` map), so it isn't written. */
export class InvalidSkillsLock extends TaggedError<"InvalidSkillsLock"> {
  readonly _tag = "InvalidSkillsLock";
  constructor(
    readonly path: string,
    readonly problem: string,
  ) {
    super(`${path} can't be read (${problem}). Fix it by hand first; Dark Matter won't overwrite it.`);
  }
}

/** A Copy's files were edited in the repo: replacing or removing them needs `discardEdits` (#28). */
export class CopyModifiedInRepo extends TaggedError<"CopyModifiedInRepo"> {
  readonly _tag = "CopyModifiedInRepo";
  constructor(
    readonly path: string,
    readonly key: string,
  ) {
    super(`${key} was modified in repo at ${path}. Pull the edits into the Library, or confirm discarding them.`);
  }
}

/** A Project's `skills-lock.json` entry names a Skill that isn't in the Library and can't be Imported yet. */
export class NotInLibrary extends TaggedError<"NotInLibrary"> {
  readonly _tag = "NotInLibrary";
  constructor(
    readonly skillName: string,
    readonly source: string,
  ) {
    super(`${skillName} (from ${source}) isn't in the Library, and only GitHub Sources can be Imported to fulfil it.`);
  }
}

/** A Library MCP Server name that has no file under `mcp/`. */
export class McpServerNotFound extends TaggedError<"McpServerNotFound"> {
  readonly _tag = "McpServerNotFound";
  constructor(readonly server: string) {
    super(`No Library MCP Server ${server}`);
  }
}

/** The OS keychain couldn't be reached (no `security` or `secret-tool`, or it refused). */
export class KeychainUnavailable extends TaggedError<"KeychainUnavailable"> {
  readonly _tag = "KeychainUnavailable";
  constructor(readonly problem: string) {
    super(`The keychain isn't available: ${problem}`);
  }
}

/** Import (#30) couldn't read what was pasted as a GitHub Source. */
export class InvalidImportSource extends TaggedError<"InvalidImportSource"> {
  readonly _tag = "InvalidImportSource";
  constructor(readonly input: string) {
    super(`${input} isn't owner/repo, a GitHub repo or tree URL, or a skills.sh listing URL`);
  }
}

/** A GitHub Source, ref or path can't be reached: missing, renamed, private without access, or offline. */
export class SourceUnreachable extends TaggedError<"SourceUnreachable"> {
  readonly _tag = "SourceUnreachable";
  constructor(
    readonly source: string,
    readonly problem: string,
  ) {
    super(`Can't reach ${source}: ${problem}`);
  }
}

/** GitHub's rate limit is used up (60 requests an hour without a token). */
export class RateLimited extends TaggedError<"RateLimited"> {
  readonly _tag = "RateLimited";
  constructor(readonly resetAt: string | null) {
    super(
      `GitHub's rate limit is used up${resetAt ? ` until ${resetAt}` : ""}. Log in with \`gh auth login\` or add a token in Settings.`,
    );
  }
}

/** A picked Skill folder that the Source doesn't have at the previewed commit. */
export class ImportSkillNotFound extends TaggedError<"ImportSkillNotFound"> {
  readonly _tag = "ImportSkillNotFound";
  constructor(
    readonly source: string,
    readonly path: string,
  ) {
    super(`${source} has no Skill at ${path}`);
  }
}

/** An update met a Modified Skill (#33): choose Take upstream, Keep mine or Detach. */
export class SkillModified extends TaggedError<"SkillModified"> {
  readonly _tag = "SkillModified";
  constructor(readonly key: string) {
    super(`${key} was changed since it was Imported: choose Take upstream, Keep mine or Detach`);
  }
}

/** There's no pending update for this Skill (#33): run Check for updates first. */
export class NoUpdate extends TaggedError<"NoUpdate"> {
  readonly _tag = "NoUpdate";
  constructor(readonly key: string) {
    super(`${key} has no update waiting`);
  }
}

/** A Secret a definition refers to isn't in the keychain: enter it first. */
export class SecretMissing extends TaggedError<"SecretMissing"> {
  readonly _tag = "SecretMissing";
  constructor(readonly secret: string) {
    super(`The Secret ${secret} isn't in the keychain yet`);
  }
}

/** The Project hasn't added this Library MCP Server. */
export class ProjectMcpServerNotFound extends TaggedError<"ProjectMcpServerNotFound"> {
  readonly _tag = "ProjectMcpServerNotFound";
  constructor(
    readonly path: string,
    readonly server: string,
  ) {
    super(`${path} has no Project MCP Server ${server}`);
  }
}

/** A definition uses something an Agent's config format can't express (e.g. an env reference inside a Codex arg). */
export class McpNotTranslatable extends TaggedError<"McpNotTranslatable"> {
  readonly _tag = "McpNotTranslatable";
  constructor(
    readonly agent: string,
    readonly problem: string,
  ) {
    super(`Can't write this MCP Server for ${agent}: ${problem}`);
  }
}

/** A Shared MCP entry was edited in the repo (#39): Take the Library version or Pull into Library, or confirm discarding it. */
export class McpModifiedInRepo extends TaggedError<"McpModifiedInRepo"> {
  readonly _tag = "McpModifiedInRepo";
  constructor(
    readonly server: string,
    readonly file: string,
  ) {
    super(`${server} was modified in repo in ${file}. Pull the edit into the Library, or confirm discarding it.`);
  }
}

/** A Personal and a Shared Project MCP Server can't share one config file: the file is either excluded or committed. */
export class McpFileShared extends TaggedError<"McpFileShared"> {
  readonly _tag = "McpFileShared";
  constructor(readonly file: string) {
    super(
      `${file} holds Shared MCP Servers, which are committed, so a Personal one can't go there (or the other way round)`,
    );
  }
}

/** A Shared (committed) delivery would put a value that is or looks like a Secret into the repo, in a place that can't hold a reference. */
export class McpSecretInShared extends TaggedError<"McpSecretInShared"> {
  readonly _tag = "McpSecretInShared";
  constructor(
    readonly server: string,
    readonly where: string,
  ) {
    super(
      `${server} can't be Shared: its ${where} holds what looks like a Secret, which would be committed. Move it into an env var or header as a Secret reference first, or deliver it as Personal`,
    );
  }
}

/** A Personal MCP entry was edited by hand since Dark Matter wrote it (story 104); it's never overwritten or removed without asking. */
export class McpEditedByHand extends TaggedError<"McpEditedByHand"> {
  readonly _tag = "McpEditedByHand";
  constructor(
    readonly server: string,
    readonly file: string,
  ) {
    super(`${server} was edited by hand in ${file}. Confirm discarding the edit, or keep it as it is.`);
  }
}

/** A Secret that On Personal deliveries still use can't be deleted: turn them Off or edit the definitions first. */
export class SecretInUse extends TaggedError<"SecretInUse"> {
  readonly _tag = "SecretInUse";
  constructor(
    readonly secret: string,
    readonly servers: string[],
  ) {
    super(`The Secret ${secret} is still delivered by ${servers.join(", ")}`);
  }
}

/** No Collection has this name. */
export class CollectionNotFound extends TaggedError<"CollectionNotFound"> {
  readonly _tag = "CollectionNotFound";
  constructor(readonly collection: string) {
    super(`No Collection named ${collection}`);
  }
}

/** Another Collection already has this name. */
export class CollectionExists extends TaggedError<"CollectionExists"> {
  readonly _tag = "CollectionExists";
  constructor(readonly collection: string) {
    super(`A Collection named ${collection} already exists`);
  }
}

/** Applying a Collection named a Skill or MCP Server that isn't one of its items. */
export class CollectionItemNotFound extends TaggedError<"CollectionItemNotFound"> {
  readonly _tag = "CollectionItemNotFound";
  constructor(
    readonly collection: string,
    readonly key: string,
  ) {
    super(`${key} isn't in the Collection ${collection}`);
  }
}

/** A client other than the app asked for a change only the app can make (ADR-0006). */
export class AppOnly extends TaggedError<"AppOnly"> {
  readonly _tag = "AppOnly";
  constructor(readonly operation: string) {
    super(`${operation} can only be done in the Dark Matter app`);
  }
}

/**
 * A Request is waiting for you to approve or deny it in the app. Not a failure:
 * the caller gets the Request (its id and plan) in `error.data.request`.
 */
export class RequestPending extends TaggedError<"RequestPending"> {
  readonly _tag = "RequestPending";
  constructor(readonly request: { id: string; summary: string }) {
    super(`Waiting for approval in Dark Matter: ${request.summary} (Request ${request.id})`);
  }
}

/** You denied the Request. */
export class RequestDenied extends TaggedError<"RequestDenied"> {
  readonly _tag = "RequestDenied";
  constructor(readonly id: string) {
    super(`Request ${id} was denied`);
  }
}

/** The Request waited 24 hours without an answer. */
export class RequestExpired extends TaggedError<"RequestExpired"> {
  readonly _tag = "RequestExpired";
  constructor(readonly id: string) {
    super(`Request ${id} expired`);
  }
}

/** No Request has this id (any more). */
export class RequestNotFound extends TaggedError<"RequestNotFound"> {
  readonly _tag = "RequestNotFound";
  constructor(readonly id: string) {
    super(`No Request ${id}`);
  }
}

/** The Request was already approved or denied. */
export class RequestDecided extends TaggedError<"RequestDecided"> {
  readonly _tag = "RequestDecided";
  constructor(
    readonly id: string,
    readonly status: string,
  ) {
    super(`Request ${id} is already ${status}`);
  }
}

/** No restorable deleted Skill has this id in `trash/` (it was purged or restored). */
export class TrashedSkillNotFound extends TaggedError<"TrashedSkillNotFound"> {
  readonly _tag = "TrashedSkillNotFound";
  constructor(readonly id: string) {
    super(`${id} isn't in the trash any more`);
  }
}

/** Something a plan step was about to change changed on disk since it was planned (review #21); nothing past it ran. */
export class PlanTargetChanged extends TaggedError<"PlanTargetChanged"> {
  readonly _tag = "PlanTargetChanged";
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path} ${reason}; nothing was changed`);
  }
}

/** A Skill couldn't be copied out of the fetched Source while Importing (review #21). */
export class ImportFailed extends TaggedError<"ImportFailed"> {
  readonly _tag = "ImportFailed";
  constructor(
    readonly skill: string,
    readonly reason: string,
  ) {
    super(`${skill} couldn't be Imported: ${reason}`);
  }
}

/** An approved Request arrived before the core could apply Requests (it's still starting). Try again. */
export class RequestsNotReady extends TaggedError<"RequestsNotReady"> {
  readonly _tag = "RequestsNotReady";
  constructor() {
    super("The core can't apply Requests yet: it's still starting. Try again in a moment.");
  }
}
