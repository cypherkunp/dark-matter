import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpDefinition } from "@dark-matter/contracts";
import type { AgentPathEnv } from "./agents";
import { jsonc, readConfigText, toml } from "./config-edit";

/**
 * One MCP Server entry in an Agent's config: its name, its key path in the
 * file, the entry as the Agent wrote it, and its Agent-neutral definition.
 */
export interface McpEntry {
  name: string;
  at: string[];
  raw: Record<string, unknown>;
  definition: McpDefinition;
}

/**
 * An Agent's MCP facts (#3, research/mcp-config-per-agent.md, November 2026):
 * where its global config is, the file format, and how to read its entries
 * into Agent-neutral definitions. Edits go through `mcpConfigEdits` by format.
 * Translating a Library definition back into the Agent's format (#38) belongs here too.
 */
export interface AgentMcp {
  /** The global config file, absolute. Dark Matter only ever removes from it (ADR-0002). */
  globalFile(env: AgentPathEnv): Promise<string>;
  format: "json" | "toml";
  /** The MCP Servers a parsed config declares. Entries of unknown shape are skipped. */
  servers(config: unknown): McpEntry[];
}

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

const stringMap = (value: unknown, refs: (text: string) => string): Record<string, string> | undefined => {
  if (!isObj(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string | number | boolean] =>
      typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean",
  );
  return Object.fromEntries(entries.map(([key, inner]) => [key, refs(String(inner))]));
};

const nonEmpty = <T extends object>(value: T | undefined): T | undefined =>
  value && Object.keys(value).length > 0 ? value : undefined;

/** Drops undefined fields, so definitions compare and serialise the same way. */
const definition = (fields: { [K in keyof McpDefinition]: McpDefinition[K] | undefined }): McpDefinition =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as McpDefinition;

const entriesOf = (map: unknown, at: string[], read: (raw: Obj, name: string) => McpDefinition | null) => {
  if (!isObj(map)) return [];
  return Object.entries(map).flatMap(([name, raw]): McpEntry[] => {
    if (!isObj(raw)) return [];
    const parsed = read(raw, name);
    return parsed ? [{ name, at: [...at, name], raw, definition: parsed }] : [];
  });
};

/** The replacement that turns a captured name into an `${env:…}` reference. */
const ENV_REF = `$\{env:$1}`;
/** Claude Code `${VAR}` → `${env:VAR}`. `${VAR:-default}` is kept as written. */
const claudeRefs = (text: string) => text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ENV_REF);
/** Cursor already writes `${env:VAR}`. */
const cursorRefs = (text: string) => text;
/** OpenCode `{env:VAR}` → `${env:VAR}`. `{file:…}` is kept as written. */
const opencodeRefs = (text: string) => text.replace(/(?<!\$)\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, ENV_REF);

/** The `mcpServers` entry shape shared by Claude Code and Cursor. */
const mcpServersEntry =
  (refs: (text: string) => string) =>
  (raw: Obj): McpDefinition | null => {
    const type = typeof raw.type === "string" ? raw.type : undefined;
    const url = typeof raw.url === "string" ? refs(raw.url) : undefined;
    const command = typeof raw.command === "string" ? refs(raw.command) : undefined;
    const stdio = type === undefined ? url === undefined : type === "stdio";
    if (stdio) {
      if (!command) return null;
      return definition({
        transport: "stdio",
        command,
        args: nonEmpty(strings(raw.args)?.map(refs)),
        env: nonEmpty(stringMap(raw.env, refs)),
        cwd: typeof raw.cwd === "string" ? refs(raw.cwd) : undefined,
        url: undefined,
        headers: undefined,
      });
    }
    const transport =
      type === "sse" ? "sse" : type === undefined || type === "http" || type === "streamable-http" ? "http" : null;
    if (!transport || !url) return null;
    return definition({
      transport,
      url,
      headers: nonEmpty(stringMap(raw.headers, refs)),
      command: undefined,
      args: undefined,
      env: undefined,
      cwd: undefined,
    });
  };

const opencodeEntry = (raw: Obj): McpDefinition | null => {
  if (raw.type === "local") {
    const command = strings(raw.command)?.map(opencodeRefs);
    if (!command?.[0]) return null;
    return definition({
      transport: "stdio",
      command: command[0],
      args: nonEmpty(command.slice(1)),
      env: nonEmpty(stringMap(raw.environment, opencodeRefs)),
      cwd: typeof raw.cwd === "string" ? opencodeRefs(raw.cwd) : undefined,
      url: undefined,
      headers: undefined,
    });
  }
  if (raw.type === "remote" && typeof raw.url === "string") {
    return definition({
      transport: "http",
      url: opencodeRefs(raw.url),
      headers: nonEmpty(stringMap(raw.headers, opencodeRefs)),
      command: undefined,
      args: undefined,
      env: undefined,
      cwd: undefined,
    });
  }
  return null;
};

/** Codex names env vars instead of interpolating: `env_vars`, `bearer_token_env_var`, `env_http_headers`. */
const codexEntry = (raw: Obj): McpDefinition | null => {
  const envRef = (name: string) => `\${env:${name}}`;
  if (typeof raw.url === "string") {
    const headers = {
      ...stringMap(raw.http_headers, (text) => text),
      ...Object.fromEntries(
        Object.entries(stringMap(raw.env_http_headers, (text) => text) ?? {}).map(([key, name]) => [key, envRef(name)]),
      ),
      ...(typeof raw.bearer_token_env_var === "string" && {
        Authorization: `Bearer ${envRef(raw.bearer_token_env_var)}`,
      }),
    };
    return definition({
      transport: "http",
      url: raw.url,
      headers: nonEmpty(headers),
      command: undefined,
      args: undefined,
      env: undefined,
      cwd: undefined,
    });
  }
  if (typeof raw.command !== "string") return null;
  const env = {
    ...stringMap(raw.env, (text) => text),
    ...Object.fromEntries((strings(raw.env_vars) ?? []).map((name) => [name, envRef(name)])),
  };
  return definition({
    transport: "stdio",
    command: raw.command,
    args: nonEmpty(strings(raw.args)),
    env: nonEmpty(env),
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    url: undefined,
    headers: undefined,
  });
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** `~/.claude.json` top-level `mcpServers` ("user" scope): a hot state file, so every edit is a targeted patch. */
export const claudeMcp: AgentMcp = {
  globalFile: async ({ home }) => join(home, ".claude.json"),
  format: "json",
  servers: (config) =>
    entriesOf(isObj(config) ? config.mcpServers : undefined, ["mcpServers"], mcpServersEntry(claudeRefs)),
};

/** `~/.cursor/mcp.json` `mcpServers`. Its on/off state lives in Cursor's private database and is never touched. */
export const cursorMcp: AgentMcp = {
  globalFile: async ({ home }) => join(home, ".cursor/mcp.json"),
  format: "json",
  servers: (config) =>
    entriesOf(isObj(config) ? config.mcpServers : undefined, ["mcpServers"], mcpServersEntry(cursorRefs)),
};

/** OpenCode's global `opencode.jsonc` (else `opencode.json`): V2 `mcp.servers.<name>` and V1 `mcp.<name>`. */
export const opencodeMcp: AgentMcp = {
  globalFile: async ({ home }) => {
    const jsoncFile = join(home, ".config/opencode/opencode.jsonc");
    return (await exists(jsoncFile)) ? jsoncFile : join(home, ".config/opencode/opencode.json");
  },
  format: "json",
  servers: (config) => {
    const mcp = isObj(config) && isObj(config.mcp) ? config.mcp : {};
    const v1 = Object.fromEntries(
      Object.entries(mcp).filter(([key, value]) => key !== "servers" && isObj(value) && typeof value.type === "string"),
    );
    return [...entriesOf(mcp.servers, ["mcp", "servers"], opencodeEntry), ...entriesOf(v1, ["mcp"], opencodeEntry)];
  },
};

/** `~/.codex/config.toml` `[mcp_servers.<name>]`. `CODEX_HOME` isn't honoured yet. */
export const codexMcp: AgentMcp = {
  globalFile: async ({ home }) => join(home, ".codex/config.toml"),
  format: "toml",
  servers: (config) => entriesOf(isObj(config) ? config.mcp_servers : undefined, ["mcp_servers"], codexEntry),
};

/** Reading, removing and putting back an entry, by file format. */
export const mcpConfigEdits = {
  json: {
    read: (text: string, path: string) => jsonc.read(text, path),
    remove: (text: string, at: string[]) => jsonc.remove(text, at),
    restore: (text: string, at: string[], raw: Obj) => jsonc.set(text, at, raw),
  },
  toml: {
    read: (text: string, path: string) => toml.read(text, path),
    remove: (text: string, at: string[]) => toml.removeTable(text, at),
    restore: (text: string, at: string[], raw: Obj) => toml.setTable(text, at, raw),
  },
} as const;

/** An Agent's global MCP config as it is now: its file, text and entries. A file that doesn't parse has none. */
export const readGlobalMcp = async (mcp: AgentMcp, env: AgentPathEnv) => {
  const file = await mcp.globalFile(env);
  const text = await readConfigText(file);
  if (text === null) return { file, text: "", entries: [] as McpEntry[], problem: null };
  try {
    return { file, text, entries: mcp.servers(mcpConfigEdits[mcp.format].read(text, file)), problem: null };
  } catch (error) {
    return { file, text, entries: [] as McpEntry[], problem: error instanceof Error ? error.message : String(error) };
  }
};
