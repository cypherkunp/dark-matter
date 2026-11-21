import { readFile, realpath, stat } from "node:fs/promises";
import { InvalidAgentConfig } from "@dark-matter/contracts";
import { parse as parseToml, patch as patchToml } from "@decimalturn/toml-patch";
import {
  applyEdits,
  type FormattingOptions,
  type JSONPath,
  modify,
  type ParseError,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser";
import { writeFileAtomic } from "./atomic";
import { toSortedJson } from "./sorted-json";

/**
 * Targeted, format-preserving edits to config files that Agents own (Claude
 * Code settings, OpenCode JSON/JSONC, Codex TOML; MCP configs reuse these).
 * Every edit works on the file's current text and changes only the keys it
 * names: comments, ordering, indentation and unknown keys survive.
 */

/**
 * Re-reads `path` (following symlinks to the real file), applies `edit` to its
 * text ("" when missing) and writes the result atomically, keeping the file's
 * mode. Returns the path written, or null when nothing changed.
 */
export const editConfigFile = async (path: string, edit: (text: string) => string): Promise<string | null> => {
  const target = await realpath(path).catch(() => path);
  const [text, mode] = await Promise.all([
    readFile(target, "utf8").catch(missingAs("")),
    stat(target).then((info) => info.mode & 0o777, missingAs(0o644)),
  ]);
  let next: string;
  try {
    next = edit(text);
  } catch (error) {
    throw error instanceof InvalidAgentConfig ? new InvalidAgentConfig(path, error.problem) : error;
  }
  if (next === text) return null;
  await writeFileAtomic(target, next, mode);
  return target;
};

/** Reads a config file's text, or null when it doesn't exist. */
export const readConfigText = (path: string): Promise<string | null> => readFile(path, "utf8").catch(missingAs(null));

const missingAs =
  <T>(fallback: T) =>
  (error: unknown): T => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  };

/** JSON and JSONC (comments, trailing commas), edited with `jsonc-parser` as OpenCode itself does. */
export const jsonc = {
  /** The parsed value; `{}` for an empty file. Throws `InvalidAgentConfig` if it doesn't parse. */
  read(text: string, path = "config"): unknown {
    if (text.trim() === "") return {};
    const errors: ParseError[] = [];
    const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
    const first = errors[0];
    if (first) throw new InvalidAgentConfig(path, `${printParseErrorCode(first.error)} at offset ${first.offset}`);
    return value;
  },
  /** Sets the value at `at`, creating parent objects as needed. Refuses text that doesn't parse. */
  set(text: string, at: JSONPath, value: unknown): string {
    jsonc.read(text);
    return applyEdits(text, modify(text, at, value, { formattingOptions: formattingOf(text) }));
  },
  /** Appends `value` to the array at `at`, creating it as needed. Refuses text that doesn't parse. */
  append(text: string, at: JSONPath, value: unknown): string {
    jsonc.read(text);
    return applyEdits(
      text,
      modify(text, [...at, -1], value, { formattingOptions: formattingOf(text), isArrayInsertion: true }),
    );
  },
};

/** The file's own indentation and line endings, so new keys look like their neighbours. */
const formattingOf = (text: string): FormattingOptions => {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.startsWith("\t"),
    tabSize: indent.startsWith("\t") ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
};

type TomlTable = Record<string, unknown>;

/**
 * TOML, edited with a CST-preserving patcher (`@decimalturn/toml-patch`).
 * New tables are appended as real `[table]` / `[[table]]` blocks rather than
 * inline tables; each result is re-parsed and checked before it's returned.
 */
export const toml = {
  /** The parsed document. Throws `InvalidAgentConfig` if it doesn't parse. */
  read(text: string, path = "config"): TomlTable {
    try {
      return parseToml(text) as TomlTable;
    } catch (error) {
      throw new InvalidAgentConfig(path, error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));
    }
  },
  /** Sets `table.key = value` (e.g. `["skills", "bundled"]`, `"enabled"`). */
  set(text: string, table: string[], key: string, value: TomlScalar): string {
    const expected = toml.read(text);
    const parent = tableAt(expected, table);
    if (parent[key] === value) return text;
    parent[key] = value;
    if (lookup(toml.read(text), table) === undefined) {
      return verified(appendBlock(text, `[${table.map(tomlKey).join(".")}]`, { [key]: value }), expected);
    }
    return verified(patchToml(text, expected), expected);
  },
  /** Appends an entry to the array of tables at `table` (e.g. `[[skills.config]]`). */
  appendTable(text: string, table: string[], entry: Record<string, TomlScalar>): string {
    const expected = toml.read(text);
    const parentPath = table.slice(0, -1);
    const name = table.at(-1) ?? "";
    const parent = tableAt(expected, parentPath);
    const existing = parent[name];
    parent[name] = [...(Array.isArray(existing) ? existing : []), entry];
    if (existing === undefined) {
      const appended = appendBlock(text, `[[${table.map(tomlKey).join(".")}]]`, entry);
      if (matches(appended, expected)) return appended;
    }
    return verified(patchToml(text, expected), expected);
  },
};

type TomlScalar = string | number | boolean;

const lookup = (doc: TomlTable, path: string[]): unknown =>
  path.reduce<unknown>((at, key) => (isTable(at) ? at[key] : undefined), doc);

const tableAt = (doc: TomlTable, path: string[]): TomlTable => {
  let at = doc;
  for (const key of path) {
    const next = at[key];
    if (next === undefined) at[key] = {};
    else if (!isTable(next)) throw new InvalidAgentConfig("config", `\`${path.join(".")}\` isn't a table`);
    at = at[key] as TomlTable;
  }
  return at;
};

const isTable = (value: unknown): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

const appendBlock = (text: string, header: string, entries: Record<string, TomlScalar>): string => {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = Object.entries(entries).map(([key, value]) => `${tomlKey(key)} = ${JSON.stringify(value)}`);
  const lead = text === "" ? "" : text.endsWith(eol) ? eol : eol + eol;
  return `${text}${lead}${[header, ...body].join(eol)}${eol}`;
};

const matches = (text: string, expected: TomlTable): boolean => {
  try {
    return toSortedJson(parseToml(text)) === toSortedJson(expected);
  } catch {
    return false;
  }
};

const verified = (next: string, expected: TomlTable): string => {
  if (!matches(next, expected)) throw new InvalidAgentConfig("config", "the edit didn't round-trip");
  return next;
};
