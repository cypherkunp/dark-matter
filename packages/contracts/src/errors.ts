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

/** An MCP Server name is already taken where it would go (a Library name, or an Agent config on Undo). */
export class NameConflict extends TaggedError<"NameConflict"> {
  readonly _tag = "NameConflict";
  constructor(
    readonly server: string,
    readonly where: string,
  ) {
    super(`${server} is already taken in ${where}`);
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
