import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ManagedSkill, OffScope } from "@dark-matter/contracts";
import { claudeDir, codexDir, opencodeDir } from "./agent-dirs";
import type { AgentPathEnv } from "./agents";
import { jsonc, toml } from "./config-edit";
import { fromHomeRelative } from "./home-path";

/**
 * Agent-managed Skills (#25): where each Agent keeps the Skills it installs and
 * controls itself, and how its own global settings turn one off. Facts from the
 * Skill discovery research (#2) and the #9 resolution, checked November 2026.
 */

/** A folder of Agent-managed Skills, one `<name>/SKILL.md` per entry. */
export interface ManagedFolder {
  path: string;
  kind: ManagedSkill["kind"];
  /** The plugin these Skills come with, as the Agent names it. */
  plugin: string | null;
}

/** What an off switch needs to know about one Agent-managed Skill. */
export interface ManagedSkillRef {
  /** The name the Agent uses for it: frontmatter `name`, else its folder name. */
  name: string;
  /** Its folder name (OpenCode's Skill ID). */
  folderName: string;
  /** Its real `SKILL.md` path (Codex's path selector). */
  skillFile: string;
  kind: ManagedSkill["kind"];
  plugin: string | null;
}

/** The off switches' view of a scanned Agent-managed Skill. */
export const managedSkillRef = (
  skill: Pick<ManagedSkill, "name" | "path" | "kind" | "plugin">,
  home: string,
): ManagedSkillRef => {
  const path = fromHomeRelative(home, skill.path);
  return {
    name: skill.name,
    folderName: basename(path),
    skillFile: join(path, "SKILL.md"),
    kind: skill.kind,
    plugin: skill.plugin,
  };
};

/** "Turn off everywhere" through one Agent's global config file. */
export interface OffSwitches {
  /** The config file it edits. */
  file(env: AgentPathEnv): Promise<string>;
  /** The scopes it offers for a Skill, the narrowest first. */
  scopes(skill: ManagedSkillRef): OffScope[];
  /** The setting a scope writes, as the user would read it in the file. */
  setting(skill: ManagedSkillRef, scope: OffScope): string;
  /** Whether the config text already turns the Skill off. Throws if the text doesn't parse. */
  isOff(config: string, skill: ManagedSkillRef): boolean;
  /** The config text with the Skill turned off in `scope`; only the targeted keys change. */
  turnOff(config: string, skill: ManagedSkillRef, scope: OffScope): string;
}

export interface AgentManagedSkills {
  /** Folders holding its Agent-managed Skills. Only reads. */
  folders(env: AgentPathEnv): Promise<ManagedFolder[]>;
  /** Null when the Agent has no off switch (Cursor), so Dark Matter never writes its settings. */
  off: OffSwitches | null;
}

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};

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

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The most recently modified folder: the version a plugin cache currently serves. */
const newest = async (paths: string[]): Promise<string | undefined> => {
  const dated = await Promise.all(paths.map(async (path) => ({ path, mtime: (await stat(path)).mtimeMs })));
  return dated.sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path))[0]?.path;
};

/** `<cache>/<marketplace>/<plugin>/<version>/skills`, newest version per plugin. */
const pluginCacheFolders = async (
  cache: string,
  name: (marketplace: string, plugin: string) => string,
): Promise<ManagedFolder[]> => {
  const folders: ManagedFolder[] = [];
  for (const marketplace of await subdirs(cache)) {
    for (const plugin of await subdirs(marketplace)) {
      const version = await newest(await subdirs(plugin));
      if (!version) continue;
      const mkt = marketplace.slice(cache.length + 1);
      folders.push({
        path: join(version, "skills"),
        kind: "plugin",
        plugin: name(mkt, plugin.slice(marketplace.length + 1)),
      });
    }
  }
  return folders;
};

/**
 * Claude Code: plugin Skills under each installed plugin's `installPath`
 * (`~/.claude/plugins/installed_plugins.json`), and claude.ai Skills synced into
 * `~/.claude/skills/synced/`. Bundled Skills live in the binary and aren't listed.
 * Off: `enabledPlugins` for a plugin's Skills, `skillOverrides: "off"` otherwise.
 */
export const claudeManaged: AgentManagedSkills = {
  async folders(env) {
    const registry = await readJson(join(claudeDir(env), "plugins/installed_plugins.json"));
    const folders: ManagedFolder[] = [];
    for (const [plugin, installs] of Object.entries(asObject(registry.plugins)).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      for (const install of Array.isArray(installs) ? installs : []) {
        const installPath = asObject(install).installPath;
        if (typeof installPath === "string")
          folders.push({ path: join(installPath, "skills"), kind: "plugin", plugin });
      }
    }
    folders.push({ path: join(claudeDir(env), "skills/synced"), kind: "synced", plugin: null });
    return folders;
  },
  off: {
    file: async (env) => join(claudeDir(env), "settings.json"),
    scopes: (skill) => (skill.plugin ? ["plugin"] : ["skill"]),
    setting: (skill, scope) =>
      scope === "plugin"
        ? `"enabledPlugins": { ${JSON.stringify(skill.plugin)}: false }`
        : `"skillOverrides": { ${JSON.stringify(skill.name)}: "off" }`,
    isOff(config, skill) {
      const settings = asObject(jsonc.read(config));
      return skill.plugin
        ? asObject(settings.enabledPlugins)[skill.plugin] === false
        : asObject(settings.skillOverrides)[skill.name] === "off";
    },
    turnOff: (config, skill, scope) =>
      scope === "plugin" && skill.plugin
        ? jsonc.set(config, ["enabledPlugins", skill.plugin], false)
        : jsonc.set(config, ["skillOverrides", skill.name], "off"),
  },
};

/**
 * Cursor: built-ins in `~/.cursor/skills-cursor/` and plugin Skills in its plugin
 * cache. Cursor has no off switch, so these are read-only.
 */
export const cursorManaged: AgentManagedSkills = {
  folders: async ({ home }) => [
    { path: join(home, ".cursor/skills-cursor"), kind: "bundled", plugin: null },
    ...(await pluginCacheFolders(join(home, ".cursor/plugins/cache"), (_, plugin) => plugin)),
  ],
  off: null,
};

/**
 * OpenCode: Skills from `skills` catalogs, cached under `~/.cache/opencode/skills/<hash>/`.
 * Built-ins live in the binary. Off: a `skill` permission `deny` rule in the
 * global `opencode.json[c]`, written in the shape the file already uses
 * (v2 `permissions` array, else v1 `permission.skill` map).
 */
export const opencodeManaged: AgentManagedSkills = {
  folders: async ({ home }) =>
    (await subdirs(join(home, ".cache/opencode/skills"))).map((path) => ({ path, kind: "cached", plugin: null })),
  off: {
    async file(env) {
      const jsoncFile = join(opencodeDir(env), "opencode.jsonc");
      return (await exists(jsoncFile)) ? jsoncFile : join(opencodeDir(env), "opencode.json");
    },
    scopes: () => ["skill"],
    setting: (skill) =>
      `"permissions": [{ "action": "skill", "resource": ${JSON.stringify(skill.folderName)}, "effect": "deny" }]`,
    isOff(config, skill) {
      const settings = asObject(jsonc.read(config));
      if (opencodeShape(settings) === "v1") {
        const rule = asObject(settings.permission).skill;
        return typeof rule === "string" ? rule === "deny" : asObject(rule)[skill.folderName] === "deny";
      }
      const rules = (Array.isArray(settings.permissions) ? settings.permissions : []).map(asObject);
      const last = rules.findLast(
        (rule) => rule.action === "skill" && (rule.resource === skill.folderName || rule.resource === "*"),
      );
      return last?.effect === "deny";
    },
    turnOff(config, skill) {
      const settings = asObject(jsonc.read(config));
      if (opencodeShape(settings) === "v2") {
        return jsonc.append(config, ["permissions"], { action: "skill", resource: skill.folderName, effect: "deny" });
      }
      const current = asObject(settings.permission).skill;
      if (typeof current === "string") {
        return jsonc.set(config, ["permission", "skill"], { "*": current, [skill.folderName]: "deny" });
      }
      return jsonc.set(config, ["permission", "skill", skill.folderName], "deny");
    },
  },
};

/** A v1 file has a `permission` object and no `permissions` array; anything else is written as v2. */
const opencodeShape = (settings: Json): "v1" | "v2" =>
  settings.permission !== undefined && settings.permissions === undefined ? "v1" : "v2";

/**
 * Codex: bundled (system) Skills in `$CODEX_HOME/skills/.system/` and plugin Skills
 * in `$CODEX_HOME/plugins/cache/`. Off: `[[skills.config]] path = … enabled = false`
 * for one Skill, or `[skills.bundled] enabled = false` for every bundled one.
 */
export const codexManaged: AgentManagedSkills = {
  folders: async (env) => [
    { path: join(codexDir(env), "skills/.system"), kind: "bundled", plugin: null },
    ...(await pluginCacheFolders(join(codexDir(env), "plugins/cache"), (mkt, plugin) => `${plugin}@${mkt}`)),
  ],
  off: {
    file: async (env) => join(codexDir(env), "config.toml"),
    scopes: (skill) => (skill.kind === "bundled" ? ["skill", "bundled"] : ["skill"]),
    setting: (skill, scope) =>
      scope === "bundled"
        ? "[skills.bundled] enabled = false"
        : `[[skills.config]] path = ${JSON.stringify(skill.skillFile)}, enabled = false`,
    isOff(config, skill) {
      const skills = asObject(toml.read(config).skills);
      if (skill.kind === "bundled" && asObject(skills.bundled).enabled === false) return true;
      const entries = (Array.isArray(skills.config) ? skills.config : []).map(asObject);
      const last = entries.findLast((entry) => entry.path === skill.skillFile || entry.name === skill.name);
      return last?.enabled === false;
    },
    turnOff: (config, skill, scope) =>
      scope === "bundled"
        ? toml.set(config, ["skills", "bundled"], "enabled", false)
        : toml.appendTable(config, ["skills", "config"], { path: skill.skillFile, enabled: false }),
  },
};

/** The `.agents` convention has no Agent-managed Skills. */
export const noManaged: AgentManagedSkills = { folders: async () => [], off: null };

const readJson = async (path: string): Promise<Json> => {
  try {
    return asObject(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return {};
  }
};
