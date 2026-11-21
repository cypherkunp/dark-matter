import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ManagedMcpServer, McpDefinition, McpOffScope } from "@dark-matter/contracts";
import type { AgentPathEnv } from "./agents";
import { jsonc, toml } from "./config-edit";
import { claudeRefs, codexEntry, cursorRefs, entriesOf, mcpServersEntry } from "./mcp-agents";

/**
 * Agent-managed MCP Servers (#40): servers an Agent adds and controls itself
 * (plugins, claude.ai connectors, built-ins, marketplace and team servers,
 * system, cloud and MDM config layers). Dark Matter lists them read-only and
 * offers "Turn off everywhere" only through a global setting the Agent
 * documents; the setting each Agent uses is recorded on its `off` switches.
 * Facts from research/mcp-config-per-agent.md and the Agents' docs and source,
 * checked November 2026.
 */

/** What an off switch needs to know about one Agent-managed MCP Server. */
export interface ManagedMcpRef {
  name: string;
  kind: ManagedMcpServer["kind"];
  plugin: string | null;
}

/** One Agent-managed MCP Server as an adapter reads it. */
export interface FoundManagedMcp extends ManagedMcpRef {
  /** The file declaring it, absolute; null when it isn't in a file. */
  source: string | null;
  definition: McpDefinition | null;
  /** Off regardless of the off switches' file, e.g. a built-in that's off until you opt in. */
  offByDefault?: boolean;
}

/** "Turn off everywhere" through one Agent's documented global settings file. */
export interface ManagedMcpOff {
  file(env: AgentPathEnv): string;
  /** The scopes offered for a server, the narrowest first; empty when it's read-only. */
  scopes(server: ManagedMcpRef): McpOffScope[];
  /** The setting a scope writes, as the user would read it in the file. */
  setting(server: ManagedMcpRef, scope: McpOffScope): string;
  /** Whether the settings text already turns the server off. Throws if the text doesn't parse. */
  isOff(config: string, server: ManagedMcpRef): boolean;
  /** The settings text with the server turned off in `scope`; only the targeted keys change. */
  turnOff(config: string, server: ManagedMcpRef, scope: McpOffScope): string;
}

export interface AgentManagedMcp {
  /** Its Agent-managed MCP Servers. Only reads. */
  servers(env: AgentPathEnv): Promise<FoundManagedMcp[]>;
  /** Null when the Agent has no documented global off setting (Cursor). */
  off: ManagedMcpOff | null;
  /** Why a server with no off switch is read-only, and how to turn it off in the Agent. */
  readOnly(server: ManagedMcpRef): string;
  /** Agent-managed MCP Servers that exist but aren't on disk, so a Scan can't list them. */
  notes: readonly string[];
}

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};

const readText = (path: string) => readFile(path, "utf8").catch(() => null);
const readJson = async (path: string): Promise<Json | null> => {
  const text = await readText(path);
  if (text === null) return null;
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
};

const subdirs = async (path: string): Promise<string[]> => {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(path, entry.name))
      .sort();
  } catch {
    return [];
  }
};

/** The most recently modified folder: the version a plugin cache currently serves. */
const newest = async (paths: string[]): Promise<string | undefined> => {
  const dated = await Promise.all(paths.map(async (path) => ({ path, mtime: (await stat(path)).mtimeMs })));
  return dated.sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path))[0]?.path;
};

const system = (env: AgentPathEnv, path: string) => join(env.systemRoot ?? "/", path);

/**
 * A plugin's MCP Servers: `mcpServers` in its manifest (an inline map, or a
 * path to a file), else its own `.mcp.json` / `mcp.json`. Server files are a
 * `{ "mcpServers": {…} }` wrapper or a flat map.
 */
const pluginServers = async (root: string, manifest: string, files: string[]) => {
  const declared = (await readJson(join(root, manifest)))?.mcpServers;
  const candidates: { file: string; map: unknown }[] = [];
  if (typeof declared === "string") {
    const file = resolve(root, declared);
    candidates.push({ file, map: await readJson(file) });
  } else if (declared !== undefined) {
    candidates.push({ file: join(root, manifest), map: declared });
  } else {
    for (const name of files) {
      const map = await readJson(join(root, name));
      if (map) {
        candidates.push({ file: join(root, name), map });
        break;
      }
    }
  }
  return candidates.map(({ file, map }) => {
    const object = asObject(map);
    return { file, servers: isObjectMap(object.mcpServers) ? object.mcpServers : object };
  });
};

const isObjectMap = (value: unknown): value is Json => Object.keys(asObject(value)).length > 0;

const CLAUDE_CONNECTORS = "claude.ai connectors";

/**
 * Claude Code (settings in `~/.claude/settings.json`, docs code.claude.com/docs/en/settings):
 * - plugin servers, named `plugin:<plugin>:<server>`: off with `"enabledPlugins": { "<plugin@marketplace>": false }`
 *   (Claude Code disconnects a disabled plugin's MCP servers);
 * - claude.ai connectors (signed in with a claude.ai account; listed on claude.ai, not on disk):
 *   off with `"disableClaudeAiConnectors": true`;
 * - built-ins (`claude-in-chrome`, `computer-use`): no documented global setting, so read-only.
 */
export const claudeManagedMcp: AgentManagedMcp = {
  async servers(env) {
    const found: FoundManagedMcp[] = [];
    const registry = await readJson(join(env.home, ".claude/plugins/installed_plugins.json"));
    for (const [plugin, installs] of Object.entries(asObject(registry?.plugins)).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const install = (Array.isArray(installs) ? installs : []).map(asObject).at(-1);
      if (typeof install?.installPath !== "string") continue;
      const short = plugin.split("@")[0] ?? plugin;
      for (const { file, servers } of await pluginServers(install.installPath, ".claude-plugin/plugin.json", [
        ".mcp.json",
      ])) {
        for (const entry of entriesOf(servers, [], mcpServersEntry(claudeRefs))) {
          found.push({
            name: `plugin:${short}:${entry.name}`,
            kind: "plugin",
            plugin,
            source: file,
            definition: entry.definition,
          });
        }
      }
    }
    const state = await readJson(join(env.home, ".claude.json"));
    if (state?.oauthAccount !== undefined) {
      found.push({ name: CLAUDE_CONNECTORS, kind: "connector", plugin: null, source: null, definition: null });
    }
    if (state && Object.keys(state).some((key) => /chrome/i.test(key))) {
      found.push({
        name: "claude-in-chrome",
        kind: "builtin",
        plugin: null,
        source: null,
        definition: null,
        offByDefault: state.claudeInChromeDefaultEnabled !== true,
      });
    }
    return found;
  },
  off: {
    file: ({ home }) => join(home, ".claude/settings.json"),
    scopes: (server) => (server.kind === "plugin" ? ["plugin"] : server.kind === "connector" ? ["connectors"] : []),
    setting: (server, scope) =>
      scope === "plugin"
        ? `"enabledPlugins": { ${JSON.stringify(server.plugin)}: false }`
        : '"disableClaudeAiConnectors": true',
    isOff(config, server) {
      const settings = asObject(jsonc.read(config));
      if (server.kind === "plugin" && server.plugin) return asObject(settings.enabledPlugins)[server.plugin] === false;
      if (server.kind === "connector")
        return (
          settings.disableClaudeAiConnectors === true || asObject(settings.env).ENABLE_CLAUDEAI_MCP_SERVERS === "false"
        );
      return false;
    },
    turnOff: (config, server, scope) =>
      scope === "plugin" && server.plugin
        ? jsonc.set(config, ["enabledPlugins", server.plugin], false)
        : jsonc.set(config, ["disableClaudeAiConnectors"], true),
  },
  readOnly: (server) =>
    server.name === "claude-in-chrome"
      ? "Built into Claude Code with no global setting to turn it off. Use /chrome in Claude Code."
      : "Built into Claude Code with no global setting to turn it off. Use /mcp in Claude Code.",
  notes: [
    "claude.ai connectors are set up on claude.ai, so each one isn't listed; they're turned off together.",
    "Servers from managed settings (managed-mcp.json) are set by your administrator.",
  ],
};

/**
 * Cursor: marketplace (`cursor-public`) and team-marketplace plugins in
 * `~/.cursor/plugins/cache/<marketplace>/<plugin>/<version>/`, and local plugins in
 * `~/.cursor/plugins/local/<plugin>/`. Cursor keeps MCP on/off only in its private
 * state database, which Dark Matter never writes, so all are read-only.
 */
export const cursorManagedMcp: AgentManagedMcp = {
  async servers(env) {
    const found: FoundManagedMcp[] = [];
    const add = async (root: string, kind: FoundManagedMcp["kind"], plugin: string) => {
      for (const { file, servers } of await pluginServers(root, ".cursor-plugin/plugin.json", [
        "mcp.json",
        ".mcp.json",
      ])) {
        for (const entry of entriesOf(servers, [], mcpServersEntry(cursorRefs))) {
          found.push({
            name: `plugin-${plugin}-${entry.name}`,
            kind,
            plugin,
            source: file,
            definition: entry.definition,
          });
        }
      }
    };
    const cache = join(env.home, ".cursor/plugins/cache");
    for (const marketplace of await subdirs(cache)) {
      for (const plugin of await subdirs(marketplace)) {
        const version = await newest(await subdirs(plugin));
        if (version)
          await add(version, basename(marketplace) === "cursor-public" ? "marketplace" : "team", basename(plugin));
      }
    }
    for (const plugin of await subdirs(join(env.home, ".cursor/plugins/local"))) {
      await add(plugin, "plugin", basename(plugin));
    }
    return found;
  },
  off: null,
  readOnly: () =>
    "Cursor keeps MCP on/off in its private database, which Dark Matter never writes. Turn it off in Cursor Settings → MCP.",
  notes: ["Team MCP Servers set in the Cursor dashboard aren't stored on disk, so they can't be listed."],
};

/** A plugin source that mentions MCP; plugins register servers through config/mcp transforms. */
const mentionsMcp = (text: string | null) => text !== null && /\bmcp\b/i.test(text);

/**
 * OpenCode: plugins add MCP Servers at start-up through transforms, so their
 * names aren't on disk. Plugins that touch MCP are listed: local plugin files in
 * `~/.config/opencode/plugins/` (V1 `plugin/`) and npm plugins named in the
 * global config's `plugins` (V1 `plugin`), installed under `~/.config/opencode/node_modules`.
 * OpenCode documents no setting that turns off a plugin's server, so read-only.
 */
export const opencodeManagedMcp: AgentManagedMcp = {
  async servers(env) {
    const root = join(env.home, ".config/opencode");
    const found: FoundManagedMcp[] = [];
    for (const folder of ["plugins", "plugin"]) {
      let names: string[] = [];
      try {
        names = (await readdir(join(root, folder))).filter((name) => /\.(m?[jt]s)$/.test(name)).sort();
      } catch {}
      for (const name of names) {
        const file = join(root, folder, name);
        if (mentionsMcp(await readText(file))) {
          const plugin = name.replace(/\.[^.]+$/, "");
          found.push({ name: plugin, kind: "plugin", plugin, source: file, definition: null });
        }
      }
    }
    const configText =
      (await readText(join(root, "opencode.jsonc"))) ?? (await readText(join(root, "opencode.json"))) ?? "";
    let config: Json = {};
    try {
      config = asObject(jsonc.read(configText));
    } catch {}
    const specs = [config.plugins, config.plugin].flatMap((list) =>
      (Array.isArray(list) ? list : []).filter((spec): spec is string => typeof spec === "string"),
    );
    for (const spec of specs) {
      if (spec.startsWith("-") || spec.includes("*")) continue;
      const pkg = spec.replace(/(?<=.)@[^@/]*$/, "");
      const folder = join(root, "node_modules", pkg);
      const manifest = await readJson(join(folder, "package.json"));
      if (!manifest) continue;
      const main = typeof manifest.main === "string" ? manifest.main : "index.js";
      if (mentionsMcp(await readText(join(folder, main)))) {
        found.push({ name: pkg, kind: "plugin", plugin: pkg, source: join(folder, "package.json"), definition: null });
      }
    }
    return found;
  },
  off: null,
  readOnly: () =>
    "This OpenCode plugin adds its MCP Servers when OpenCode starts, and OpenCode has no setting to turn one off. Remove or disable the plugin in opencode.json.",
  notes: [],
};

const run = promisify(execFile);

/** The `config_toml_base64` an MDM profile forces for `com.openai.codex` (XML, or binary via `plutil` on macOS). */
const mdmConfigToml = async (plist: string): Promise<string | null> => {
  const raw = await readFile(plist).catch(() => null);
  if (!raw) return null;
  let text = raw.toString("utf8");
  if (text.startsWith("bplist")) {
    if (process.platform !== "darwin") return null;
    text = await run("plutil", ["-convert", "xml1", "-o", "-", plist]).then(
      ({ stdout }) => stdout,
      () => "",
    );
  }
  const base64 = /<key>config_toml_base64<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
  return base64 ? Buffer.from(base64.trim(), "base64").toString("utf8") : null;
};

/**
 * Codex config layers (codex-rs/config/src/loader, high → low): MDM managed
 * preferences and `/etc/codex/managed_config.toml` above everything, then the
 * user's `~/.codex/config.toml`, the cloud-managed bundle, then `/etc/codex/config.toml`.
 * Tables merge field by field, so a user-level `[mcp_servers.<name>] enabled = false`
 * (the documented per-server flag) turns off a system or cloud server; managed and
 * MDM servers sit above the user layer and are read-only.
 */
export const codexManagedMcp: AgentManagedMcp = {
  async servers(env) {
    const found: FoundManagedMcp[] = [];
    const layer = async (file: string, text: string | null, kind: FoundManagedMcp["kind"]) => {
      if (text === null) return;
      let parsed: unknown;
      try {
        parsed = toml.read(text, file);
      } catch {
        return;
      }
      for (const entry of entriesOf(asObject(parsed).mcp_servers, [], (raw) => codexEntry(raw))) {
        if (found.some((server) => server.name === entry.name)) continue;
        found.push({ name: entry.name, kind, plugin: null, source: file, definition: entry.definition });
      }
    };
    const plist = system(env, "Library/Managed Preferences/com.openai.codex.plist");
    await layer(plist, await mdmConfigToml(plist), "managed");
    const managed = system(env, "etc/codex/managed_config.toml");
    await layer(managed, await readText(managed), "managed");
    const systemFile = system(env, "etc/codex/config.toml");
    await layer(systemFile, await readText(systemFile), "system");
    return found;
  },
  off: {
    file: ({ home }) => join(home, ".codex/config.toml"),
    scopes: (server) => (server.kind === "system" ? ["server"] : []),
    setting: (server) => `[mcp_servers.${tomlKey(server.name)}] enabled = false`,
    isOff: (config, server) => asObject(asObject(toml.read(config).mcp_servers)[server.name]).enabled === false,
    turnOff: (config, server) => toml.set(config, ["mcp_servers", server.name], "enabled", false),
  },
  readOnly: () => "Set by your administrator (managed config or MDM), which overrides your own Codex config.",
  notes: [
    "Cloud-managed config comes from your workspace when Codex starts and isn't stored on disk, so it can't be listed.",
  ],
};

const tomlKey = (name: string) => (/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name));
