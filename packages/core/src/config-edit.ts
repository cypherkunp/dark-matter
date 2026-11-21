import { readFile, realpath, stat } from "node:fs/promises";
import { InvalidAgentConfig } from "@dark-matter/contracts";
import { parse as parseToml, patch as patchToml } from "@decimalturn/toml-patch";
import {
  applyEdits,
  type FormattingOptions,
  findNodeAtLocation,
  type JSONPath,
  modify,
  type ParseError,
  parse as parseJsonc,
  parseTree,
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
  /**
   * Removes the property at `at`: its lines (with a comment on its last line)
   * and its comma. Everything around it stays byte for byte, except the comma
   * before it when it was the last property. The result is checked by parsing.
   */
  remove(text: string, at: JSONPath): string {
    const before = jsonc.read(text);
    const expected = structuredClone(before);
    const parent = at
      .slice(0, -1)
      .reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), expected);
    const key = String(at.at(-1));
    if (!isRecord(parent) || !(key in parent)) return text;
    delete parent[key];
    const sliced = removeProperty(text, at);
    if (sliced !== null && toSortedJson(jsonc.read(sliced)) === toSortedJson(expected)) return sliced;
    return applyEdits(text, modify(text, at, undefined, { formattingOptions: formattingOf(text) }));
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Skips spaces, tabs and comments (not newlines) from `at`. */
const skipInline = (text: string, at: number): number => {
  let i = at;
  for (;;) {
    while (text[i] === " " || text[i] === "\t") i++;
    if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return i;
      i = close + 2;
    } else return i;
  }
};

/** Skips whitespace (newlines too) and comments backwards from just before `at`. */
const skipBack = (text: string, at: number): number => {
  let i = at;
  while (i > 0 && /\s/.test(text[i - 1] ?? "")) i--;
  return i;
};

/** The text with one property cut out by its own lines, or null when the layout is unusual. */
const removeProperty = (text: string, at: JSONPath): string | null => {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  const property = tree && findNodeAtLocation(tree, at)?.parent;
  if (property?.type !== "property" || !property.parent) return null;
  const siblings = property.parent.children ?? [];
  const index = siblings.indexOf(property);
  let start = property.offset;
  let end = skipInline(text, property.offset + property.length);
  let cutBefore: [number, number] | null = null;
  if (text[end] === ",") end = skipInline(text, end + 1);
  else if (index > 0) {
    // The last property: the comma after the one before it goes too.
    const comma = skipBack(text, start);
    if (text[comma - 1] !== ",") return null;
    cutBefore = [comma - 1, comma];
  }
  if (text.startsWith("//", end)) end = text.indexOf("\n", end) === -1 ? text.length : text.indexOf("\n", end);
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const alone = text.slice(lineStart, start).trim() === "" && (text[end] === "\n" || text.startsWith("\r\n", end));
  if (alone) {
    start = lineStart;
    end += text[end] === "\n" ? 1 : 2;
  } else if (text[end - 1] !== "," && text[end] !== "}") {
    return null;
  }
  const cut = text.slice(0, start) + text.slice(end);
  return cutBefore ? cut.slice(0, cutBefore[0]) + cut.slice(cutBefore[1]) : cut;
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
  /**
   * Removes the table at `table` (e.g. `["mcp_servers", "github"]`) with its
   * sub-tables and the comment lines directly above its header. Every other
   * byte stays as it was. Falls back to the CST patcher for inline forms.
   */
  removeTable(text: string, table: string[]): string {
    const expected = toml.read(text);
    const parent = lookup(expected, table.slice(0, -1));
    const name = table.at(-1) ?? "";
    if (!isTable(parent) || parent[name] === undefined) return text;
    delete parent[name];
    const lines = text.split(/(?<=\n)/);
    const kept: string[] = [];
    let removing = false;
    for (const [index, line] of lines.entries()) {
      const keys = headerKeys(line);
      if (keys) removing = startsWith(keys, table);
      if (keys && removing) {
        // Its own comment block (directly above the header) goes with it.
        while (kept.length > 0 && isComment(kept.at(-1) ?? "")) kept.pop();
      }
      if (!removing) {
        kept.push(line);
        continue;
      }
      // Comments directly above the next header belong to that table.
      const next = lines.slice(index + 1).findIndex((later) => !isComment(later));
      const nextKeys = next === -1 ? null : headerKeys(lines[index + 1 + next] ?? "");
      if (isComment(line) && nextKeys && !startsWith(nextKeys, table)) kept.push(line);
    }
    const sliced = kept.join("");
    if (matches(sliced, expected)) return sliced;
    // An implicit parent (`mcp_servers` with no header of its own) goes with its last table.
    const pruned = structuredClone(expected);
    const owner = lookup(pruned, table.slice(0, -2));
    const parentName = table.at(-2);
    if (parentName && isTable(owner) && isTable(owner[parentName]) && Object.keys(owner[parentName]).length === 0) {
      delete owner[parentName];
      if (matches(sliced, pruned)) return sliced;
    }
    return verified(patchToml(text, expected), expected);
  },
  /** Sets the table at `table` to `entry` (nested values as arrays and inline tables), appended as a block. */
  setTable(text: string, table: string[], entry: Record<string, unknown>): string {
    const expected = toml.read(text);
    const parent = tableAt(expected, table.slice(0, -1));
    const name = table.at(-1) ?? "";
    if (parent[name] !== undefined) throw new InvalidAgentConfig("config", `\`${table.join(".")}\` already exists`);
    parent[name] = entry;
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const body = Object.entries(entry).map(([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`);
    const lead = text === "" ? "" : text.endsWith(eol) ? eol : eol + eol;
    return verified(`${text}${lead}${[`[${table.map(tomlKey).join(".")}]`, ...body].join(eol)}${eol}`, expected);
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

/**
 * The key path of a `[table]` header line (not `[[array]]`), or null for any
 * other line. Bare, "basic" and 'literal' keys, dotted.
 */
const headerKeys = (line: string): string[] | null => {
  const match = /^\s*\[(?!\[)(.*)\](?!\])\s*(?:#.*)?$/.exec(line.replace(/\r?\n$/, ""));
  if (!match?.[1]) return null;
  const keys: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let at = 0;
  const inner = match[1];
  while (at < inner.length) {
    re.lastIndex = at;
    const key = re.exec(inner);
    if (!key) return null;
    keys.push(key[1] !== undefined ? (JSON.parse(`"${key[1]}"`) as string) : (key[2] ?? key[3] ?? ""));
    at = re.lastIndex;
    if (key[4] === "") break;
  }
  return keys;
};

const startsWith = (keys: readonly string[], prefix: readonly string[]) =>
  keys.length >= prefix.length && prefix.every((key, index) => keys[index] === key);

const isComment = (line: string) => /^\s*#/.test(line);

/** A TOML value as source text: strings, numbers, booleans, arrays and inline tables. */
const tomlValue = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isTable(value)) {
    const entries = Object.entries(value).map(([key, inner]) => `${tomlKey(key)} = ${tomlValue(inner)}`);
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  throw new InvalidAgentConfig("config", `can't write ${typeof value} as TOML`);
};

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
