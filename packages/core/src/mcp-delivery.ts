import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type AgentId,
  InvalidOwnedFile,
  type McpDefinition,
  type McpDelivered,
  type McpDeliveryMode,
  type McpDeliveryStatus,
  McpServerNotFound,
  NameConflict,
  type ProjectMcpServer,
  type ProjectMcpServerRecord,
  type ProjectRecord,
} from "@dark-matter/contracts";
import type { Wrote } from "./activity";
import { type AgentAdapter, type AgentPathEnv, agentAdapters } from "./agents";
import { writeFileAtomic } from "./atomic";
import { editConfigFile, readConfigText } from "./config-edit";
import { gitExcludeFile, MCP_EXCLUDE_BLOCK, withExcludeBlock } from "./delivery";
import { fromHomeRelative, homeRelative } from "./home-path";
import { type AgentMcp, type McpTarget, mcpConfigEdits } from "./mcp-agents";
import { definitionOf, fillSecrets, type McpLibrary } from "./mcp-library";
import { secretNames } from "./mcp-secrets";
import type { SecretStore } from "./secrets";
import { toSortedJson } from "./sorted-json";

/**
 * Project MCP Server delivery (#38): turns the `mcpServers` of a Project's
 * record in `projects.json` into entries in its Agents' config files. Like
 * Project Skills (delivery.ts), `planMcpDelivery` reconciles the whole Project
 * at once, so add, On/Off, Remove, changing Agents, editing a definition and
 * rotating a Secret are all "change the record (or Library), plan, apply".
 * Each mode (Personal now, Shared in #39) is an `McpDeliveryModeAdapter`.
 */

export interface McpDeliveryContext {
  env: AgentPathEnv;
  mcp: McpLibrary;
  secrets: SecretStore;
}

export interface McpDeliveryModeAdapter {
  /** Where an Agent's entry goes in this Project. */
  target(mcp: AgentMcp, project: string, env: AgentPathEnv): Promise<McpTarget>;
  /** Whether the mode is offered for this target (Personal: not when the file is tracked by git). */
  offered(target: McpTarget, project: string): Promise<boolean>;
  /** The definition as written: Personal fills in real Secret values; Shared would write env references. */
  resolve(definition: McpDefinition, secrets: SecretStore): Promise<McpDefinition>;
  /** Whether its Project files go in `.git/info/exclude`. */
  excluded: boolean;
}

const git = (cwd: string, args: string[]) =>
  new Promise<boolean>((resolve) => execFile("git", ["-C", cwd, ...args], (error) => resolve(!error)));

/** Whether `file` (Project-relative) is tracked by the Project's git repo. No git means not tracked. */
export const isTracked = async (project: string, file: string): Promise<boolean> =>
  (await gitExcludeFile(project)) !== null && git(project, ["ls-files", "--error-unmatch", "--", file]);

/** Personal (#38): written only where you see it, with real Secret values, never committed. */
export const personalMode: McpDeliveryModeAdapter = {
  excluded: true,
  target: (mcp, project, env) => mcp.personal(project, env),
  offered: async (target, project) => target.projectFile === null || !(await isTracked(project, target.projectFile)),
  resolve: async (definition, secrets) => (await fillSecrets(definition, secrets)) as McpDefinition,
};

export const mcpDeliveryModes: Record<McpDeliveryMode, McpDeliveryModeAdapter> = { personal: personalMode };

/** The chosen Agents that have an MCP surface (never `.agents`), in screen order. */
const mcpAgents = (agents: readonly AgentId[]) =>
  agentAdapters.filter(
    (adapter): adapter is AgentAdapter & { mcp: AgentMcp } => agents.includes(adapter.id) && adapter.mcp !== null,
  );

const lookup = (doc: unknown, at: readonly string[]): unknown =>
  at.reduce<unknown>(
    (value, key) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined),
    doc,
  );

/** True for `{}`, or objects holding only empty objects: what's left of a file once its last entry goes. */
const deepEmpty = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((inner) => deepEmpty(inner));

const sameAt = (a: McpDelivered, b: McpDelivered) =>
  a.agent === b.agent && a.file === b.file && toSortedJson(a.at) === toSortedJson(b.at);

/** One config file write, carried out by `applyMcpDelivery`. */
export interface McpEdit {
  /** Home-relative. */
  file: string;
  change: string;
  run(): Promise<string | null>;
}

export interface McpDeliveryPlan {
  edits: McpEdit[];
  /** The record's `mcpServers` with what's delivered now; undefined when there are none. */
  mcpServers: Record<string, ProjectMcpServerRecord> | undefined;
  servers: ProjectMcpServer[];
  /** The info/exclude file and its new text, when it changes. */
  exclude: { path: string; text: string } | null;
}

/** The format-preserving edit for one target file. */
const formatOf = (target: McpTarget) => (target.file.endsWith(".toml") ? mcpConfigEdits.toml : mcpConfigEdits.json);

/** Removes one delivered entry; a Project file left with nothing in it goes too. */
const removal = (env: AgentPathEnv, project: string, delivered: McpDelivered): McpEdit => {
  const file = fromHomeRelative(env.home, delivered.file);
  const format = file.endsWith(".toml") ? mcpConfigEdits.toml : mcpConfigEdits.json;
  return {
    file: delivered.file,
    change: `remove ${delivered.at.join(".")}`,
    run: async () => {
      const text = await readConfigText(file);
      if (text === null || lookup(format.read(text, file), delivered.at) === undefined) return null;
      const written = await editConfigFile(file, (current) => format.remove(current, delivered.at));
      const left = await readConfigText(file);
      if (file.startsWith(`${project}/`) && left !== null && deepEmpty(format.read(left, file))) await rm(file);
      return written;
    },
  };
};

/**
 * Plans the config edits that make `project` match `record.mcpServers`.
 * `removed` are the records of Project MCP Servers just dropped, whose entries
 * go too. A name already taken in a target file by an entry Dark Matter didn't
 * write throws `NameConflict` before anything is written.
 */
export const planMcpDelivery = async (
  context: McpDeliveryContext,
  project: string,
  record: ProjectRecord,
  removed: readonly ProjectMcpServerRecord[] = [],
): Promise<McpDeliveryPlan> => {
  const { env, mcp, secrets } = context;
  const agents = mcpAgents(record.agents);
  const edits: McpEdit[] = [];
  const excluded = new Set<string>();
  const servers: ProjectMcpServer[] = [];
  const next: Record<string, ProjectMcpServerRecord> = {};
  const texts = new Map<string, unknown>();
  const parsed = async (target: McpTarget) => {
    if (!texts.has(target.file)) {
      const text = (await readConfigText(target.file)) ?? "";
      texts.set(target.file, formatOf(target).read(text, target.file));
    }
    return texts.get(target.file);
  };

  for (const gone of removed) for (const delivered of gone.delivered) edits.push(removal(env, project, delivered));

  for (const name of Object.keys(record.mcpServers ?? {}).sort()) {
    const wanted = record.mcpServers?.[name];
    if (!wanted) continue;
    const mode = mcpDeliveryModes[wanted.mode];
    const stored = await mcp.read(name);
    if (!stored) throw new McpServerNotFound(name);
    if (!stored.value) throw new InvalidOwnedFile(stored.path, stored.problem ?? "invalid");
    const definition = definitionOf(stored.value);
    const delivered: McpDelivered[] = [];
    const deliveries: McpDeliveryStatus[] = [];
    let resolved: McpDefinition | null = null;

    for (const adapter of agents) {
      const target = await mode.target(adapter.mcp, project, env);
      const file = homeRelative(env.home, target.file);
      const previous = wanted.delivered.find((entry) => entry.agent === adapter.id && entry.file === file);
      if (!(await mode.offered(target, project))) {
        // A file that became tracked keeps what's there: removing it would be a committed change.
        if (previous) delivered.push(previous);
        deliveries.push({ agent: adapter.id, file, status: "tracked" });
        continue;
      }
      if (!wanted.on) {
        deliveries.push({ agent: adapter.id, file, status: "off" });
        continue;
      }
      const at = target.at(await parsed(target), name);
      const entry: McpDelivered = { agent: adapter.id, file, at };
      const ours = wanted.delivered.some((other) => sameAt(other, entry));
      const existing = lookup(await parsed(target), at);
      if (existing !== undefined && !ours) throw new NameConflict([name], `${file} › ${at.join(".")}`);
      resolved ??= await mode.resolve(definition, secrets);
      const written = adapter.mcp.toAgent(resolved);
      if (!ours || toSortedJson(existing) !== toSortedJson(written)) {
        const format = formatOf(target);
        edits.push({
          file,
          change: `write ${at.join(".")}`,
          run: () => editConfigFile(target.file, (text) => format.write(text, at, written)),
        });
      }
      delivered.push(entry);
      if (mode.excluded && target.projectFile) excluded.add(target.projectFile);
      deliveries.push({ agent: adapter.id, file, status: "delivered" });
    }
    // Entries no longer wanted (Off, or an Agent dropped from the Project) go.
    for (const old of wanted.delivered)
      if (!delivered.some((kept) => sameAt(kept, old))) edits.push(removal(env, project, old));

    next[name] = { ...wanted, delivered };
    servers.push({ name, mode: wanted.mode, on: wanted.on, secrets: secretNames(definition), deliveries });
  }

  let exclude: McpDeliveryPlan["exclude"] = null;
  const excludePath = await gitExcludeFile(project);
  if (excludePath) {
    const current = await readFile(excludePath, "utf8").catch(() => "");
    const text = withExcludeBlock(current, [...excluded].sort(), MCP_EXCLUDE_BLOCK);
    if (text !== current) exclude = { path: excludePath, text };
  }
  return { edits, mcpServers: Object.keys(next).length > 0 ? next : undefined, servers, exclude };
};

/** Carries out a plan: the exclude block first, so a Personal file is never untracked-and-visible to git. */
export const applyMcpDelivery = async (plan: McpDeliveryPlan, wrote: Wrote) => {
  if (plan.exclude) {
    await mkdir(dirname(plan.exclude.path), { recursive: true });
    await writeFileAtomic(plan.exclude.path, plan.exclude.text);
    wrote(plan.exclude.path);
  }
  for (const edit of plan.edits) {
    const written = await edit.run();
    if (written) wrote(written);
  }
};
