import { readFile } from "node:fs/promises";
import { InvalidOwnedFile, type OwnedFileName, type OwnedFileProblem } from "@dark-matter/contracts";
import type { z } from "zod";
import { writeFileAtomic } from "./atomic";
import { toSortedJson } from "./sorted-json";

const read = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/** Parses an owned file's text; a missing file is an empty object, so the schema's defaults apply. */
const parse = <S extends z.ZodType>(schema: S, text: string | null) => {
  let json: unknown;
  try {
    json = text === null ? {} : JSON.parse(text);
  } catch (error) {
    return { success: false as const, message: `not valid JSON (${(error as Error).message})` };
  }
  const result = schema.safeParse(json);
  if (result.success) return { success: true as const, value: result.data as z.output<S> };
  const message = result.error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
  return { success: false as const, message };
};

/**
 * One owned JSON file under the Library home (ADR-0005). The core is its only
 * writer: writes are atomic, keys sorted, and validated by its `contracts`
 * schema. A hand edit that doesn't validate is held: the last good value keeps
 * serving, `problem` describes it, and writes are refused until it is fixed or
 * discarded.
 */
export class OwnedFile<S extends z.ZodType> {
  #value: z.output<S>;
  #problem: OwnedFileProblem | null = null;
  /** The text this core last wrote or accepted, so its own writes aren't re-read as hand edits. */
  #lastText: string | null;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly name: OwnedFileName,
    readonly path: string,
    private readonly schema: S,
    value: z.output<S>,
    text: string | null,
  ) {
    this.#value = value;
    this.#lastText = text;
  }

  /** Reads the file. An invalid file is held from the start, with the schema defaults serving. */
  static async open<S extends z.ZodType>(name: OwnedFileName, path: string, schema: S): Promise<OwnedFile<S>> {
    const text = await read(path);
    const parsed = parse(schema, text);
    if (parsed.success) return new OwnedFile(name, path, schema, parsed.value, text);
    const defaults = parse(schema, null);
    if (!defaults.success) throw new Error(`${name} has no valid default: ${defaults.message}`);
    const file = new OwnedFile(name, path, schema, defaults.value, null);
    file.#problem = { file: name, path, message: parsed.message };
    return file;
  }

  get value(): z.output<S> {
    return this.#value;
  }

  get problem(): OwnedFileProblem | null {
    return this.#problem;
  }

  /**
   * Validates and writes the next value. Resolves to the path written, or
   * null when nothing changed. Throws `InvalidOwnedFile` while a hand edit is held.
   */
  update(next: (current: z.output<S>) => z.input<S>): Promise<string | null> {
    return this.#serial(async () => {
      if (this.#problem) throw new InvalidOwnedFile(this.path, this.#problem.message);
      return this.#write(this.schema.parse(next(this.#value)) as z.output<S>);
    });
  }

  /** Replaces a held hand edit with the last good value. Resolves to the path written. */
  discard(): Promise<string | null> {
    return this.#serial(async () => {
      if (!this.#problem) return null;
      this.#problem = null;
      this.#lastText = null;
      return this.#write(this.#value);
    });
  }

  /**
   * Re-reads the file after it changed on disk. Resolves to true if the value
   * or the problem changed.
   */
  reload(): Promise<boolean> {
    return this.#serial(async () => {
      const text = await read(this.path);
      if (text === this.#lastText && this.#problem === null) return false;
      const parsed = parse(this.schema, text);
      if (!parsed.success) {
        if (this.#problem?.message === parsed.message) return false;
        this.#problem = { file: this.name, path: this.path, message: parsed.message };
        return true;
      }
      this.#problem = null;
      this.#lastText = text;
      this.#value = parsed.value;
      return true;
    });
  }

  async #write(value: z.output<S>): Promise<string | null> {
    const text = toSortedJson(value);
    if (text === this.#lastText) return null;
    await writeFileAtomic(this.path, text);
    this.#lastText = text;
    this.#value = value;
    return this.path;
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }
}
