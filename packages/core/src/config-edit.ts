import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
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

/** How often an edit is re-applied when the Agent rewrites the file under it. */
const EDIT_ATTEMPTS = 5;

/**
 * Re-reads `path` (following symlinks to the real file), applies `edit` to its
 * text ("" when missing) and writes the result atomically, keeping the file's
 * mode. Returns the path written, or null when nothing changed.
 *
 * Agents rewrite some of these files while they run (Claude Code rewrites
 * `~/.claude.json` many times a session, by read-modify-write). So just before
 * the rename the file is read again: if it changed since the edit read it, the
 * edit is re-applied to the new text (up to 5 times, then `InvalidAgentConfig`).
 * A write by the Agent between that last read and the rename can still be
 * lost; the window is one read plus one rename, not a whole edit.
 */
export const editConfigFile = async (path: string, edit: (text: string) => string): Promise<string | null> => {
  const target = await realpath(path).catch(() => path);
  const readText = () => readFile(target, "utf8").catch(missingAs(""));
  const mode = await stat(target).then((info) => info.mode & 0o777, missingAs(0o644));
  let text = await readText();
  for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
    let next: string;
    try {
      next = edit(text);
    } catch (error) {
      throw error instanceof InvalidAgentConfig ? new InvalidAgentConfig(path, error.problem) : error;
    }
    if (next === text) return null;
    const now = await readText();
    if (now !== text) {
      text = now;
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFileAtomic(target, next, mode);
    return target;
  }
  throw new InvalidAgentConfig(path, "it kept changing while Dark Matter was editing it; try again");
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
  /**
   * Sets the property at `at` by splicing text: a new property goes after its
   * last sibling (or into an empty object) in the file's own indentation, an
   * existing one has only its value replaced. Unlike `set`, siblings are never
   * reformatted. Missing parents are created as one nested property. The
   * result is checked by parsing; an unusual layout falls back to `set`.
   */
  put(text: string, at: string[], value: unknown): string {
    const expected = structuredClone(jsonc.read(text)) as Record<string, unknown>;
    let parent: Record<string, unknown> = expected;
    for (const key of at.slice(0, -1)) {
      if (!isRecord(parent[key])) parent[key] = {};
      parent = parent[key] as Record<string, unknown>;
    }
    parent[String(at.at(-1))] = value;
    const spliced = text.trim() === "" ? null : putProperty(text, at, value);
    if (spliced !== null && toSortedJson(jsonc.read(spliced)) === toSortedJson(expected)) return spliced;
    return jsonc.set(text, at, value);
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
  if (siblings.length === 1) {
    // The only property: an object left with nothing but whitespace closes up to `{}`, as it was before.
    const open = property.parent.offset;
    const close = open + property.parent.length - (end - start) - 1;
    if (cut[open] === "{" && cut[close] === "}" && cut.slice(open + 1, close).trim() === "")
      return `${cut.slice(0, open)}{}${cut.slice(close + 1)}`;
  }
  return cutBefore ? cut.slice(0, cutBefore[0]) + cut.slice(cutBefore[1]) : cut;
};

/** The leading whitespace of the line `offset` is on. */
const lineIndent = (text: string, offset: number) => {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? "";
};

/** `text` with the property at `at` spliced in (or its value replaced), or null for a layout it can't place. */
const putProperty = (text: string, at: readonly string[], value: unknown): string | null => {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  if (!tree) return null;
  const { insertSpaces, tabSize, eol = "\n" } = formattingOf(text);
  const unit = insertSpaces ? " ".repeat(tabSize ?? 2) : "\t";
  const render = (inner: unknown, indent: string) =>
    JSON.stringify(inner, null, unit)
      .split("\n")
      .join(eol + indent);

  const existing = findNodeAtLocation(tree, [...at]);
  if (existing) {
    const indent = lineIndent(text, existing.parent?.offset ?? existing.offset);
    return text.slice(0, existing.offset) + render(value, indent) + text.slice(existing.offset + existing.length);
  }
  // The deepest object that exists; the rest of the path becomes one nested property in it.
  let depth = at.length - 1;
  while (depth > 0 && findNodeAtLocation(tree, at.slice(0, depth))?.type !== "object") depth--;
  const object = depth === 0 ? tree : findNodeAtLocation(tree, at.slice(0, depth));
  if (object?.type !== "object") return null;
  const nested = at.slice(depth + 1).reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
  const children = object.children ?? [];
  const last = children.at(-1);
  if (!last) {
    const outer = lineIndent(text, object.offset);
    const inner = outer + unit;
    const body = `${eol}${inner}${JSON.stringify(at[depth])}: ${render(nested, inner)}${eol}${outer}`;
    return `${text.slice(0, object.offset)}{${body}}${text.slice(object.offset + object.length)}`;
  }
  const indent = lineIndent(text, last.offset);
  const property = `${JSON.stringify(at[depth])}: ${render(nested, indent)}`;
  const end = last.offset + last.length;
  let after = skipInline(text, end);
  if (text[after] === ",") {
    // A trailing comma (JSONC): the new property goes after it, with one of its own.
    after = skipInline(text, after + 1);
    if (text.startsWith("//", after))
      after = text.indexOf("\n", after) === -1 ? text.length : text.indexOf("\n", after);
    return `${text.slice(0, after)}${eol}${indent}${property},${text.slice(after)}`;
  }
  return `${text.slice(0, end)},${eol}${indent}${property}${text.slice(end)}`;
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
    let sliced = kept.join("");
    // A table removed from the end takes the blank line that set it apart, as `setTable` added it.
    if (removing) sliced = sliced.replace(/(\r?\n)(?:[ \t]*\r?\n)+$/, "$1");
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
