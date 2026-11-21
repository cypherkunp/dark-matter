import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type {
  AgentScan,
  GlobalMcpServer,
  GlobalSkill,
  ManagedMcpServer,
  ManagedSkill,
  ProjectScan,
  ProjectSkillEntry,
  ScanResult,
  SkillLocation,
} from "@dark-matter/contracts";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type AgentAdapter, type AgentPathEnv, agentAdapters, type SkillFolder } from "./agents";
import { readConfigText } from "./config-edit";
import { gitTrackedPaths } from "./git-tracked";
import { homeRelative } from "./home-path";
import { managedSkillRef } from "./managed-skills";
import { readGlobalMcp } from "./mcp-agents";
import { maskSecrets } from "./mcp-secrets";
import { suggestProjects } from "./projects";
import { readGlobalLock } from "./skill-lock";

export interface ScanOptions {
  /** Confirmed Projects, by absolute path: their skill folders are read too. */
  projects?: readonly string[];
  /** Folders never suggested as Projects (the Library). */
  exclude?: readonly string[];
}
/**
 * The Scan (#10): a strictly read-only sweep of every Agent's global skill
 * folders, the `skills` CLI's global lock, every Agent's history (for
 * Suggested Projects) and the skill folders of confirmed Projects. It only
 * ever reads; the caller caches what it returns.
 */
export const scan = async (
  env: AgentPathEnv,
  adapters = agentAdapters,
  now = new Date(),
  options: ScanOptions = {},
): Promise<ScanResult> => {
  const folders = uniqueFolders(adapters, env);
  const lock = (await readGlobalLock(env.home))?.entries ?? {};
  const ownRoots = await realPaths([
    ...folders.map((folder) => folder.path),
    ...adapters.map((adapter) => adapter.configDir(env)),
  ]);
  const folderReals = new Map(
    await Promise.all(folders.map(async (folder) => [folder.path, await realOrNull(folder.path)] as const)),
  );

  const byRealPath = new Map<string, Found>();
  for (const folder of folders) {
    for (const entry of await listSkillEntries(folder)) {
      const found = byRealPath.get(entry.realPath) ?? { realPath: entry.realPath, entries: [] };
      found.entries.push({ folder: folder.path, ...entry });
      byRealPath.set(entry.realPath, found);
    }
  }

  const agentsOf = (folderPath: string) =>
    adapters
      .filter((adapter) => adapter.skills.globalFolders(env).some((folder) => folder.path === folderPath))
      .map((adapter) => adapter.id);
  const rel = (path: string) => homeRelative(env.home, path);

  const globalSkills: GlobalSkill[] = [];
  for (const found of byRealPath.values()) {
    const first = found.entries[0];
    if (!first) continue;
    const meta = await readFrontmatter(found.realPath);
    const home = found.entries.find((entry) => folderReals.get(entry.folder) === dirname(found.realPath)) ?? first;
    const agents = new Set(found.entries.flatMap((entry) => agentsOf(entry.folder)));
    const locked = found.entries
      .filter((entry) => entry.folder === join(env.home, ".agents/skills"))
      .map((entry) => lock[basename(entry.path)])
      .find((entry) => entry !== undefined);
    globalSkills.push({
      id: `global-skill:${rel(found.realPath)}`,
      name: meta.name ?? basename(found.realPath),
      description: meta.description ?? "",
      realPath: rel(found.realPath),
      folder: rel(home.folder),
      locations: found.entries.map(
        (entry): SkillLocation => ({ folder: rel(entry.folder), path: rel(entry.path), symlink: entry.symlink }),
      ),
      agents: adapters.map((adapter) => adapter.id).filter((id) => agents.has(id)),
      source: locked?.source ?? null,
      localSource: !ownRoots.some((root) => found.realPath.startsWith(root + sep)),
    });
  }
  globalSkills.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
  const managedSkills = await findManagedSkills(env, adapters);
  const mcp = await findGlobalMcpServers(env, adapters);
  const managedMcpServers = await findManagedMcpServers(env, adapters);

  const agents: AgentScan[] = await Promise.all(
    adapters.map(async (adapter) => {
      const own = adapter.skills.globalFolders(env).map((folder) => folder.path);
      return {
        id: adapter.id,
        detected: await isDirectory(adapter.configDir(env)),
        globalSkillFolders: await Promise.all(
          own.map(async (path) => ({ path: rel(path), exists: await isDirectory(path) })),
        ),
        globalSkillCount: [...byRealPath.values()].filter((found) =>
          found.entries.some((entry) => own.includes(entry.folder)),
        ).length,
        managedSkillCount: managedSkills.filter((skill) => skill.agent === adapter.id).length,
        mcpConfig: mcp.files.get(adapter.id) ?? null,
        globalMcpServerCount: mcp.servers.filter((server) => server.agent === adapter.id).length,
        managedMcpServerCount: managedMcpServers.filter((server) => server.agent === adapter.id).length,
      };
    }),
  );

  return {
    scannedAt: now.toISOString(),
    agents,
    globalSkills,
    managedSkills,
    globalMcpServers: mcp.servers,
    managedMcpServers,
    suggestedProjects: await suggestProjects(env, adapters, options.exclude),
    projects: await Promise.all((options.projects ?? []).map((path) => scanProject(path, adapters))),
  };
};

/**
 * Reads one confirmed Project's skill folders (every folder any Agent loads).
 * Entries are listed as found; classifying them (untracked, Vendored, Link,
 * Copy) is left to the tickets that act on them.
 */
export const scanProject = async (path: string, adapters: readonly AgentAdapter[]): Promise<ProjectScan> => {
  const folders = [...new Set(adapters.flatMap((adapter) => adapter.skills.projectFolders))].sort();
  const skillFolders: ProjectScan["skillFolders"] = [];
  const skills: Omit<ProjectSkillEntry, "tracked">[] = [];
  for (const folder of folders) {
    const absolute = join(path, folder);
    skillFolders.push({ path: folder, exists: await isDirectory(absolute) });
    for (const entry of await listSkillEntries({ path: absolute })) {
      const meta = await readFrontmatter(entry.realPath);
      skills.push({
        name: meta.name ?? basename(entry.path),
        description: meta.description ?? "",
        folder,
        ...entry,
      });
    }
  }
  // Git-tracked entries (or real folders) are Vendored (#10 point 7): one `git ls-files` per Project.
  const tracked = await gitTrackedPaths(path, [...new Set(skills.flatMap((skill) => [skill.path, skill.realPath]))]);
  return {
    path,
    exists: await isDirectory(path),
    skillFolders,
    skills: skills.map((skill) => ({ ...skill, tracked: tracked.has(skill.path) || tracked.has(skill.realPath) })),
    // Filled in by Scans, which knows each Project's record (what Dark Matter delivered).
    mcpServers: [],
  };
};

/**
 * Every Agent's Agent-managed Skills, read from its managed folders, with
 * whether its own settings already turn each one off. Only reads.
 */
const findManagedSkills = async (env: AgentPathEnv, adapters: readonly AgentAdapter[]): Promise<ManagedSkill[]> => {
  const rel = (path: string) => homeRelative(env.home, path);
  const found: ManagedSkill[] = [];
  for (const adapter of adapters) {
    const { off } = adapter.managed;
    const configFile = off ? await off.file(env.home) : null;
    const config = configFile ? ((await readConfigText(configFile).catch(() => null)) ?? "") : "";
    const seen = new Set<string>();
    for (const folder of await adapter.managed.folders(env.home)) {
      for (const entry of await listSkillEntries({ path: folder.path })) {
        if (seen.has(entry.realPath)) continue;
        seen.add(entry.realPath);
        const meta = await readFrontmatter(entry.realPath);
        const skill = {
          id: `managed-skill:${adapter.id}:${rel(entry.realPath)}`,
          agent: adapter.id,
          name: meta.name ?? basename(entry.path),
          description: meta.description ?? "",
          path: rel(entry.realPath),
          kind: folder.kind,
          plugin: folder.plugin,
        };
        const ref = managedSkillRef(skill, env.home);
        found.push({
          ...skill,
          off: off !== null && isOffOrUnknown(() => off.isOff(config, ref)),
          offSwitches:
            off && configFile
              ? off.scopes(ref).map((scope) => ({ scope, file: rel(configFile), setting: off.setting(ref, scope) }))
              : [],
        });
      }
    }
  }
  return found.sort(
    (a, b) => a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
};

/**
 * Every Agent's Global MCP Servers, from its global MCP config. Inline
 * secrets are masked as Secret references here, so their values never reach
 * the cache or a client. Only reads.
 */
const findGlobalMcpServers = async (env: AgentPathEnv, adapters: readonly AgentAdapter[]) => {
  const files = new Map<string, string>();
  const servers: GlobalMcpServer[] = [];
  for (const adapter of adapters) {
    if (!adapter.mcp) continue;
    const config = await readGlobalMcp(adapter.mcp, env);
    const file = homeRelative(env.home, config.file);
    files.set(adapter.id, file);
    for (const entry of config.entries) {
      const masked = maskSecrets(entry.name, entry.definition);
      servers.push({
        id: `global-mcp:${adapter.id}:${entry.name}`,
        agent: adapter.id,
        name: entry.name,
        file,
        definition: masked.definition,
        inlineSecrets: masked.secrets.map((secret) => secret.key),
      });
    }
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { files, servers };
};

/**
 * Every Agent's Agent-managed MCP Servers (#40), with whether the Agent's own
 * settings already turn each off. Inline secrets are masked. Only reads.
 */
const findManagedMcpServers = async (
  env: AgentPathEnv,
  adapters: readonly AgentAdapter[],
): Promise<ManagedMcpServer[]> => {
  const rel = (path: string) => homeRelative(env.home, path);
  const found: ManagedMcpServer[] = [];
  for (const adapter of adapters) {
    const managed = adapter.managedMcp;
    if (!managed) continue;
    const { off } = managed;
    const configFile = off ? off.file(env) : null;
    const config = configFile ? ((await readConfigText(configFile).catch(() => null)) ?? "") : "";
    for (const server of await managed.servers(env)) {
      const scopes = off ? off.scopes(server) : [];
      found.push({
        id: `managed-mcp:${adapter.id}:${server.name}`,
        agent: adapter.id,
        name: server.name,
        kind: server.kind,
        plugin: server.plugin,
        source: server.source ? rel(server.source) : null,
        definition: server.definition ? maskSecrets(server.name, server.definition).definition : null,
        off:
          server.offByDefault === true ||
          (off !== null && scopes.length > 0 && isOffOrUnknown(() => off.isOff(config, server))),
        offSwitches:
          off && configFile
            ? scopes.map((scope) => ({ scope, file: rel(configFile), setting: off.setting(server, scope) }))
            : [],
        readOnly: scopes.length > 0 ? null : managed.readOnly(server),
      });
    }
  }
  return found.sort((a, b) => a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name));
};

/** A config that doesn't parse can't say a Skill is off; turning it off will report the problem. */
const isOffOrUnknown = (check: () => boolean) => {
  try {
    return check();
  } catch {
    return false;
  }
};

interface Entry {
  path: string;
  realPath: string;
  symlink: boolean;
}

interface Found {
  realPath: string;
  entries: (Entry & { folder: string })[];
}

/** Every global skill folder once, in adapter order, with its ignore list. */
const uniqueFolders = (adapters: readonly AgentAdapter[], env: AgentPathEnv): SkillFolder[] => {
  const folders = new Map<string, SkillFolder>();
  for (const adapter of adapters) {
    for (const folder of adapter.skills.globalFolders(env)) {
      if (!folders.has(folder.path)) folders.set(folder.path, folder);
    }
  }
  return [...folders.values()];
};

/**
 * The Skills directly inside one folder: entries (real or symlinked folders)
 * holding a `SKILL.md`. Hidden entries, ignored names and broken or cyclic
 * symlinks are skipped.
 */
const listSkillEntries = async (folder: SkillFolder): Promise<Entry[]> => {
  let names: string[];
  try {
    names = await readdir(folder.path);
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || folder.ignore?.includes(name)) continue;
    const path = join(folder.path, name);
    try {
      const info = await lstat(path);
      const real = await realpath(path);
      if (!(await stat(real)).isDirectory()) continue;
      if (!(await stat(join(real, "SKILL.md"))).isFile()) continue;
      entries.push({ path, realPath: real, symlink: info.isSymbolicLink() });
    } catch {
      // Not a Skill: no SKILL.md, or a broken or cyclic symlink.
    }
  }
  return entries;
};

const Frontmatter = z.looseObject({
  name: z.string().trim().min(1).optional().catch(undefined),
  description: z.string().trim().optional().catch(undefined),
});

/** `name` and `description` from `SKILL.md`'s frontmatter; missing or invalid ones are left out. */
export const readFrontmatter = async (skillDir: string): Promise<z.infer<typeof Frontmatter>> => {
  try {
    const text = await readFile(join(skillDir, "SKILL.md"), "utf8");
    const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    if (block === undefined) return {};
    const parsed = Frontmatter.safeParse(parseYaml(block));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};

const realOrNull = (path: string) => realpath(path).catch(() => null);

const realPaths = async (paths: string[]) =>
  (await Promise.all(paths.map(realOrNull))).filter((path): path is string => path !== null);

const isDirectory = (path: string) =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
