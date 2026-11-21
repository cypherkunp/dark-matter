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
