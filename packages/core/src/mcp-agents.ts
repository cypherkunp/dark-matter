import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type McpDefinition, McpNotTranslatable } from "@dark-matter/contracts";
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
  /** Where a Personal Project MCP Server goes (#38): never committed. */
  personal(project: string, env: AgentPathEnv): Promise<McpTarget>;
  /** Where a Shared Project MCP Server goes (#39): the Project's committed config file. */
  shared(project: string, env: AgentPathEnv): Promise<McpTarget>;
  /** One entry as an Agent-neutral definition (null for a shape it doesn't know). */
  read(raw: Record<string, unknown>): McpDefinition | null;
  /**
   * The Agent's own gate on a Project MCP Server it was given (#39), if it has
   * one: Cursor asks for approval, Codex loads Project config only once the
   * Project is trusted. Claude Code's `.mcp.json` approval is handled by delivery.
   */
  gate(project: string, env: AgentPathEnv): Promise<"needsApproval" | "untrusted" | undefined>;
  /**
   * A Library definition as this Agent's entry. Secrets are already resolved
   * (real values for Personal, env references for Shared), so only `${env:VAR}`
   * references are left to translate into the Agent's own syntax.
   */
  toAgent(definition: McpDefinition): Record<string, unknown>;
}

/** One config file a Project MCP Server is written into for one Agent. */
export interface McpTarget {
  /** Absolute. */
  file: string;
  /** Project-relative when the file is inside the Project (it can be tracked or git-excluded), else null. */
  projectFile: string | null;
  /** The entry's key path for `name`, given the file's parsed content (OpenCode V1 vs V2). */
  at(config: unknown, name: string): string[];
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

export const entriesOf = (map: unknown, at: string[], read: (raw: Obj, name: string) => McpDefinition | null) => {
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
export const claudeRefs = (text: string) => text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ENV_REF);
/** Cursor already writes `${env:VAR}`. */
export const cursorRefs = (text: string) => text;
/** OpenCode `{env:VAR}` → `${env:VAR}`. `{file:…}` is kept as written. */
const opencodeRefs = (text: string) => text.replace(/(?<!\$)\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, ENV_REF);

/** The `mcpServers` entry shape shared by Claude Code and Cursor. */
export const mcpServersEntry =
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
export const codexEntry = (raw: Obj): McpDefinition | null => {
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

/** Drops undefined and empty fields, keeping the order written. */
const compact = (fields: Obj): Obj =>
  Object.fromEntries(
    Object.entries(fields).filter(
      ([, value]) => value !== undefined && !(isObj(value) && Object.keys(value).length === 0),
    ),
  );

const mapValues = (map: Record<string, string> | undefined, fn: (value: string) => string) =>
  map && Object.fromEntries(Object.entries(map).map(([key, value]) => [key, fn(value)]));

const ENV_REFS = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ONLY_ENV_REF = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Rewrites every `${env:VAR}` with the Agent's syntax. */
const envSyntax = (to: (name: string) => string) => (text: string) =>
  text.replace(ENV_REFS, (_ref, name: string) => to(name));

/** Claude Code and Cursor share the `mcpServers` shape; Claude names the transport, Cursor infers it. */
const mcpServersShape =
  (refs: (text: string) => string, withType: boolean) =>
  (definition: McpDefinition): Obj =>
    definition.transport === "stdio"
      ? compact({
          ...(withType && { type: "stdio" }),
          command: definition.command && refs(definition.command),
          args: definition.args?.map(refs),
          env: mapValues(definition.env, refs),
        })
      : compact({
          ...((withType || definition.transport === "sse") && { type: definition.transport }),
          url: definition.url && refs(definition.url),
          headers: mapValues(definition.headers, refs),
        });

const opencodeShape = (definition: McpDefinition): Obj => {
  const refs = envSyntax((name) => `{env:${name}}`);
  return definition.transport === "stdio"
    ? compact({
        type: "local",
        command: [definition.command ?? "", ...(definition.args ?? [])].map(refs),
        environment: mapValues(definition.env, refs),
        cwd: definition.cwd && refs(definition.cwd),
      })
    : compact({
        type: "remote",
        url: definition.url && refs(definition.url),
        headers: mapValues(definition.headers, refs),
      });
};

/** Codex has no interpolation: env references become `env_vars`, `bearer_token_env_var` and `env_http_headers`. */
const codexShape = (definition: McpDefinition): Obj => {
  const literal = (where: string) => (text: string | undefined) => {
    if (text?.includes("${env:"))
      throw new McpNotTranslatable("codex", `${where} can't hold an env reference (${text})`);
    return text;
  };
  if (definition.transport === "stdio") {
    const env: Record<string, string> = {};
    const envVars: string[] = [];
    for (const [key, value] of Object.entries(definition.env ?? {})) {
      const ref = ONLY_ENV_REF.exec(value)?.[1];
      if (ref === key) envVars.push(key);
      else env[key] = literal(`env ${key}`)(value) ?? "";
    }
    return compact({
      command: literal("command")(definition.command),
      args: definition.args?.map((arg) => literal("args")(arg) ?? ""),
      env,
      env_vars: envVars.length > 0 ? envVars : undefined,
      cwd: literal("cwd")(definition.cwd),
    });
  }
  const httpHeaders: Record<string, string> = {};
  const envHeaders: Record<string, string> = {};
  let bearer: string | undefined;
  for (const [key, value] of Object.entries(definition.headers ?? {})) {
    const bearerRef = /^Bearer \$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
    const ref = ONLY_ENV_REF.exec(value)?.[1];
    if (key.toLowerCase() === "authorization" && bearerRef) bearer = bearerRef;
    else if (ref) envHeaders[key] = ref;
    else httpHeaders[key] = literal(`header ${key}`)(value) ?? "";
  }
  return compact({
    url: literal("url")(definition.url),
    bearer_token_env_var: bearer,
    http_headers: httpHeaders,
    env_http_headers: envHeaders,
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
  // Local scope: `projects["<abs path>"].mcpServers` in the hot state file, outside the Project.
  personal: async (project, { home }) => ({
    file: join(home, ".claude.json"),
    projectFile: null,
    at: (_config, name) => ["projects", project, "mcpServers", name],
  }),
  // Project scope: `.mcp.json`, which needs each person's approval (recorded by delivery).
  shared: async (project) => ({
    file: join(project, ".mcp.json"),
    projectFile: ".mcp.json",
    at: (_config, name) => ["mcpServers", name],
  }),
  read: mcpServersEntry(claudeRefs),
  gate: async () => undefined,
  toAgent: mcpServersShape(
    envSyntax((name) => `\${${name}}`),
    true,
  ),
};

/** `~/.cursor/mcp.json` `mcpServers`. Its on/off state lives in Cursor's private database and is never touched. */
export const cursorMcp: AgentMcp = {
  globalFile: async ({ home }) => join(home, ".cursor/mcp.json"),
  format: "json",
  servers: (config) =>
    entriesOf(isObj(config) ? config.mcpServers : undefined, ["mcpServers"], mcpServersEntry(cursorRefs)),
  personal: async (project) => cursorProjectTarget(project),
  shared: async (project) => cursorProjectTarget(project),
  read: mcpServersEntry(cursorRefs),
  // Cursor asks before it loads a Project's servers; its approvals are its own and never touched.
  gate: async () => "needsApproval",
  toAgent: mcpServersShape((text) => text, false),
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
  personal: async (project) => opencodeProjectTarget(project),
  shared: async (project) => opencodeProjectTarget(project),
  read: opencodeEntry,
  gate: async () => undefined,
  toAgent: opencodeShape,
};

/** Cursor's Project file, for Personal (git-excluded) and Shared (committed) alike. */
const cursorProjectTarget = (project: string): McpTarget => ({
  file: join(project, ".cursor/mcp.json"),
  projectFile: ".cursor/mcp.json",
  at: (_config, name) => ["mcpServers", name],
});

// The Project's `opencode.jsonc` if it has one, else `opencode.json`. Written in the file's own
// shape: V1 `mcp.<name>` when it already holds V1 entries and no `mcp.servers`, else V2.
const opencodeProjectTarget = async (project: string): Promise<McpTarget> => {
  const projectFile = (await exists(join(project, "opencode.jsonc"))) ? "opencode.jsonc" : "opencode.json";
  return {
    file: join(project, projectFile),
    projectFile,
    at: (config, name) => {
      const mcp = isObj(config) && isObj(config.mcp) ? config.mcp : {};
      const v1 =
        mcp.servers === undefined &&
        Object.entries(mcp).some(([, value]) => isObj(value) && typeof value.type === "string");
      return v1 ? ["mcp", name] : ["mcp", "servers", name];
    },
  };
};

/** `~/.codex/config.toml` `[mcp_servers.<name>]`. `CODEX_HOME` isn't honoured yet. */
export const codexMcp: AgentMcp = {
  globalFile: async ({ home }) => join(home, ".codex/config.toml"),
  format: "toml",
  servers: (config) => entriesOf(isObj(config) ? config.mcp_servers : undefined, ["mcp_servers"], codexEntry),
  // Loaded only once the Project is trusted in Codex; Dark Matter never trusts it for you.
  personal: async (project) => codexProjectTarget(project),
  shared: async (project) => codexProjectTarget(project),
  read: codexEntry,
  gate: async (project, env) => ((await codexTrusts(project, env)) ? undefined : "untrusted"),
  toAgent: codexShape,
};

/** Reading, removing and putting back an entry, by file format. */
export const mcpConfigEdits = {
  json: {
    read: (text: string, path: string) => jsonc.read(text, path),
    remove: (text: string, at: string[]) => jsonc.remove(text, at),
    restore: (text: string, at: string[], raw: Obj) => jsonc.set(text, at, raw),
    /** Writes (or replaces) the entry at `at`. A new file is pretty-printed with a final newline. */
    write: (text: string, at: string[], entry: Obj) =>
      text.trim() === ""
        ? `${JSON.stringify(
            at.reduceRight<unknown>((inner, key) => ({ [key]: inner }), entry),
            null,
            2,
          )}\n`
        : jsonc.put(text, at, entry),
  },
  toml: {
    read: (text: string, path: string) => toml.read(text, path),
    remove: (text: string, at: string[]) => toml.removeTable(text, at),
    restore: (text: string, at: string[], raw: Obj) => toml.setTable(text, at, raw),
    write: (text: string, at: string[], entry: Obj) => toml.setTable(toml.removeTable(text, at), at, entry),
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

const codexProjectTarget = (project: string): McpTarget => ({
  file: join(project, ".codex/config.toml"),
  projectFile: ".codex/config.toml",
  at: (_config, name) => ["mcp_servers", name],
});

/** Codex's user config, where it records trust: `[projects."<path>"] trust_level = "trusted"`. */
export const codexUserConfig = ({ home }: AgentPathEnv) => join(home, ".codex/config.toml");

/** Whether Codex trusts the Project, so it loads `.codex/config.toml` there. An unreadable config trusts nothing. */
export const codexTrusts = async (project: string, env: AgentPathEnv): Promise<boolean> => {
  const text = await readConfigText(codexUserConfig(env));
  if (text === null) return false;
  try {
    const config = toml.read(text, codexUserConfig(env));
    const projects = isObj(config.projects) ? config.projects : {};
    const entry = projects[project];
    return isObj(entry) && entry.trust_level === "trusted";
  } catch {
    return false;
  }
};
