import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AgentId,
  InvalidOwnedFile,
  type McpDefinition,
  type McpDelivered,
  type McpDeliveryMode,
  type McpDeliveryStatus,
  McpFileShared,
  McpSecretInShared,
  McpModifiedInRepo,
  McpServerNotFound,
  NameConflict,
  type ProjectMcpServer,
  type ProjectMcpServerRecord,
  type ProjectRecord,
} from "@dark-matter/contracts";
import type { Wrote } from "./activity";
import { type AgentAdapter, type AgentPathEnv, agentAdapters } from "./agents";
import { writeFileAtomic } from "./atomic";
import { editConfigFile, jsonc, readConfigText } from "./config-edit";
import { gitExcludeFile, MCP_EXCLUDE_BLOCK, withExcludeBlock } from "./delivery";
import { gitTrackedPaths } from "./git-tracked";
import { fromHomeRelative, homeRelative } from "./home-path";
import { type AgentMcp, type McpTarget, mcpConfigEdits } from "./mcp-agents";
import { definitionOf, fillSecrets, type McpLibrary } from "./mcp-library";
import { secretNames } from "./mcp-secrets";
import type { SecretStore } from "./secrets";
import { toSortedJson } from "./sorted-json";

/**
 * Project MCP Server delivery (#38, #39): turns the `mcpServers` of a Project's
 * record in `projects.json` into entries in its Agents' config files. Like
 * Project Skills (delivery.ts), `planMcpDelivery` reconciles the whole Project
 * at once, so add, On/Off, Remove, changing mode or Agents, editing a
 * definition and rotating a Secret are all "change the record (or Library),
 * plan, apply". Each mode (Personal, Shared) is an `McpDeliveryModeAdapter`.
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
  /** The definition as written: Personal fills in real Secret values; Shared writes env references. */
  resolve(definition: McpDefinition, secrets: SecretStore, server: string): Promise<McpDefinition>;
  /** Whether its Project files go in `.git/info/exclude`. */
  excluded: boolean;
  /** Committed for the team (#39): its entries are hashed, so hand edits and Library changes show instead of being overwritten. */
  committed: boolean;
}

/** Whether `file` (Project-relative) is tracked by the Project's git repo. No git means not tracked. */
export const isTracked = async (project: string, file: string): Promise<boolean> =>
  (await gitTrackedPaths(project, [join(project, file)])).size > 0;

/** Personal (#38): written only where you see it, with real Secret values, never committed. */
export const personalMode: McpDeliveryModeAdapter = {
  excluded: true,
  committed: false,
  target: (mcp, project, env) => mcp.personal(project, env),
  offered: async (target, project) => target.projectFile === null || !(await isTracked(project, target.projectFile)),
  resolve: async (definition, secrets) => (await fillSecrets(definition, secrets)) as McpDefinition,
};

const SECRET_REF = /\$\{secret:([^}]+)\}/g;
const ONLY_SECRET_REF = /^\$\{secret:([^}]+)\}$/;

/** The env var a Secret becomes in a Shared file when it isn't a whole env value: `linear.Authorization` → `LINEAR_AUTHORIZATION`. */
export const envVarFor = (secret: string) => {
  const name = secret
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[0-9]/.test(name) || name === "" ? `_${name}` : name;
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Only references (to env vars), optionally after an auth scheme: nothing literal is left. */
const ONLY_REFS = /^((Bearer|Basic|Token|token|bearer)\s+)?(\$\{env:[A-Za-z_][A-Za-z0-9_]*\})+$/;

/**
 * A definition with every `${secret:X}` turned into an `${env:VAR}` reference
 * (#39): an env value that is just a Secret keeps its own key as the variable
 * (so Codex can forward it with `env_vars`); anything else gets `envVarFor(X)`.
 * Every other env and header value becomes a reference too, whatever its name
 * (story 98): an env value to `${env:<its key>}`, a header to `${env:<HEADER_NAME>}`.
 * No Secret value is ever read.
 */
export const sharedDefinition = (definition: McpDefinition): McpDefinition => {
  const swap = (text: string) => text.replace(SECRET_REF, (_ref, name: string) => `\${env:${envVarFor(name)}}`);
  const map = (values: Record<string, string> | undefined, own: boolean) =>
    values &&
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        const variable = own && ENV_NAME.test(key) ? key : envVarFor(key);
        if (own && ONLY_SECRET_REF.test(value) && ENV_NAME.test(key)) return [key, `\${env:${key}}`];
        const swapped = swap(value);
        return [key, ONLY_REFS.test(swapped) ? swapped : `\${env:${variable}}`];
      }),
    );
  return {
    ...definition,
    ...(definition.command !== undefined && { command: swap(definition.command) }),
    ...(definition.args && { args: definition.args.map(swap) }),
    ...(definition.env && { env: map(definition.env, true) }),
    ...(definition.cwd !== undefined && { cwd: swap(definition.cwd) }),
    ...(definition.url !== undefined && { url: swap(definition.url) }),
    ...(definition.headers && { headers: map(definition.headers, false) }),
  };
};

/** Flag or query-parameter names that carry credentials. */
const SECRET_NAME = /(token|secret|passw(or)?d|credential|auth|api[_-]?key|access[_-]?key|private[_-]?key|^key$|^pat$|sig(nature)?$)/i;
/** Well-known token shapes (GitHub, OpenAI/Stripe, Slack, AWS, Google, GitLab, Linear, npm). */
const TOKEN_SHAPE =
  /(gh[pousr]_|github_pat_|sk-|sk_(live|test)_|rk_(live|test)_|xox[abprs]-|AKIA|AIza|glpat-|lin_api_|npm_)[A-Za-z0-9_-]{8,}/;
/** A long run that mixes letters and digits, like a key. */
const HIGH_ENTROPY = /[A-Za-z0-9+_=-]{32,}/;
const looksLikeKey = (text: string) =>
  TOKEN_SHAPE.test(text) ||
  (text.match(new RegExp(HIGH_ENTROPY, "g")) ?? []).some((run) => /[0-9]/.test(run) && /[A-Za-z]/.test(run));

/**
 * Where a Shared definition still holds something that is or looks like a
 * Secret in a place that can't become a reference (command, args, url, cwd):
 * a token shape, a password in a URL, a credential query parameter or a value
 * after a credential flag. `null` when it's clean.
 */
const secretLiteralIn = (definition: McpDefinition): string | null => {
  const literal = (text: string) => text.replace(/\$\{[^}]*\}/g, "");
  const url = (text: string): boolean => {
    if (/:\/\/[^/\s:@]+:[^@\s/]+@/.test(text)) return true;
    for (const [, key = "", value = ""] of text.matchAll(/[?&#]([^=&#]+)=([^&#]*)/g))
      if (SECRET_NAME.test(key) && literal(value) !== "") return true;
    return false;
  };
  const strings: [string, string | undefined][] = [
    ["command", definition.command],
    ["url", definition.url],
    ["working folder", definition.cwd],
  ];
  for (const [where, text] of strings) if (text !== undefined && (url(text) || looksLikeKey(literal(text)))) return where;
  const args = definition.args ?? [];
  for (const [index, arg] of args.entries()) {
    const flag = /^--?([A-Za-z0-9_-]+)(=(.*))?$/.exec(arg);
    const valueAfter = flag?.[2] !== undefined ? (flag[3] ?? "") : (args[index + 1] ?? "");
    if (flag && SECRET_NAME.test(flag[1] ?? "") && literal(valueAfter) !== "" && !valueAfter.startsWith("-"))
      return "args";
    if (url(arg) || looksLikeKey(literal(arg))) return "args";
  }
  return null;
};

/** Each env var a Shared delivery refers to, with the Secret it stands for (if any): what Pull into Library maps back. */
export const sharedEnvVars = (definition: McpDefinition): Map<string, string | null> => {
  const vars = new Map<string, string | null>();
  const shared = sharedDefinition(definition);
  const strings = (value: McpDefinition) => [
    value.command ?? "",
    ...(value.args ?? []),
    ...Object.values(value.env ?? {}),
    value.cwd ?? "",
    value.url ?? "",
    ...Object.values(value.headers ?? {}),
  ];
  for (const text of strings(shared))
    for (const match of text.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) vars.set(match[1] ?? "", null);
  // Pair each variable with its Secret by position: the two definitions differ only in references.
  const before = strings(definition);
  strings(shared).forEach((text, index) => {
    const original = before[index] ?? "";
    const secrets = [...original.matchAll(SECRET_REF)].map((match) => match[1] ?? "");
    const refs = [...text.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1] ?? "");
    const kept = [...original.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1] ?? "");
    for (const ref of refs) if (!kept.includes(ref)) vars.set(ref, secrets.shift() ?? null);
  });
  return vars;
};

/** Shared (#39): committed for the team, holding env-var references only. Never a Secret value. */
export const sharedMode: McpDeliveryModeAdapter = {
  excluded: false,
  committed: true,
  target: (mcp, project, env) => mcp.shared(project, env),
  offered: async () => true,
  resolve: async (definition, _secrets, server) => {
    const shared = sharedDefinition(definition);
    const where = secretLiteralIn(shared);
    if (where !== null) throw new McpSecretInShared(server, where);
    return shared;
  },
};

export const mcpDeliveryModes: Record<McpDeliveryMode, McpDeliveryModeAdapter> = {
  personal: personalMode,
  shared: sharedMode,
};

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

/** The hash a Shared entry is recorded with, to tell a hand edit from what Dark Matter wrote. */
export const entryHash = (entry: unknown) =>
  createHash("sha256").update(toSortedJson(entry)).digest("hex").slice(0, 16);

/** One config file write, carried out by `applyMcpDelivery`. */
export interface McpEdit {
  /** Home-relative. */
  file: string;
  change: string;
  /** It edits a committed (Shared) file: a team change. */
  team: boolean;
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

export interface McpPlanOptions {
  /** Servers whose Shared deliveries are brought up to the Library version (Update, mode switch). */
  refresh?: readonly string[];
  /** Servers whose Shared entries modified in repo may be overwritten or removed (confirmed). */
  discard?: readonly string[];
}

/** The format-preserving edit for one file. */
const formatOf = (file: string) => (file.endsWith(".toml") ? mcpConfigEdits.toml : mcpConfigEdits.json);

/** Claude Code's per-person settings in a Project, where your approval of a `.mcp.json` server goes. */
const CLAUDE_LOCAL_SETTINGS = ".claude/settings.local.json";

/** Removes one delivered entry; a Project file left with nothing in it goes too. */
const removal = (env: AgentPathEnv, project: string, delivered: McpDelivered): McpEdit => {
  const file = fromHomeRelative(env.home, delivered.file);
  const format = formatOf(file);
  return {
    file: delivered.file,
    change: `remove ${delivered.at.join(".")}`,
    team: delivered.written !== undefined,
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
 * write throws `NameConflict`, and removing (or, on Update, overwriting) a
 * Shared entry modified in repo throws `McpModifiedInRepo`, before anything is
 * written. An outdated or modified Shared entry is otherwise left as it is.
 */
export const planMcpDelivery = async (
  context: McpDeliveryContext,
  project: string,
  record: ProjectRecord,
  removed: Readonly<Record<string, ProjectMcpServerRecord>> = {},
  options: McpPlanOptions = {},
): Promise<McpDeliveryPlan> => {
  const { env, mcp, secrets } = context;
  const refresh = new Set(options.refresh);
  const discard = new Set(options.discard);
  const agents = mcpAgents(record.agents);
  const edits: McpEdit[] = [];
  const excluded = new Set<string>();
  const servers: ProjectMcpServer[] = [];
  const next: Record<string, ProjectMcpServerRecord> = {};
  const docs = new Map<string, unknown>();
  /** Parsed config files, read once per plan. */
  const parsed = async (file: string) => {
    if (!docs.has(file)) docs.set(file, formatOf(file).read((await readConfigText(file)) ?? "", file));
    return docs.get(file);
  };
  /** Project files by the mode written into them, so Personal and Shared never share one. */
  const filesByMode = { personal: new Set<string>(), shared: new Set<string>() };
  /** Claude Code `.mcp.json` servers delivered now, and those Dark Matter delivered before. */
  const claudeShared = { now: new Set<string>(), before: new Set<string>() };

  /** Throws when an entry Dark Matter wrote for the team was edited since, unless discarding is confirmed. */
  const checkUnmodified = async (name: string, delivered: McpDelivered) => {
    if (delivered.written === undefined || discard.has(name)) return;
    const existing = lookup(await parsed(fromHomeRelative(env.home, delivered.file)), delivered.at);
    if (existing !== undefined && entryHash(existing) !== delivered.written)
      throw new McpModifiedInRepo(name, delivered.file);
  };

  for (const [name, gone] of Object.entries(removed))
    for (const delivered of gone.delivered) {
      await checkUnmodified(name, delivered);
      if (delivered.written !== undefined && delivered.agent === "claude-code") claudeShared.before.add(name);
      edits.push(removal(env, project, delivered));
    }

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
    for (const old of wanted.delivered)
      if (old.agent === "claude-code" && old.written !== undefined) claudeShared.before.add(name);

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
      const doc = await parsed(target.file);
      const at = target.at(doc, name);
      const entry: McpDelivered = { agent: adapter.id, file, at };
      const ours = wanted.delivered.find((other) => sameAt(other, entry));
      const existing = lookup(doc, at);
      if (existing !== undefined && !ours) throw new NameConflict([name], `${file} › ${at.join(".")}`);
      resolved ??= await mode.resolve(definition, secrets, name);
      const written = adapter.mcp.toAgent(resolved);
      let status: McpDeliveryStatus["status"] = "delivered";
      let write = !ours || existing === undefined || toSortedJson(existing) !== toSortedJson(written);
      if (write && ours?.written !== undefined && existing !== undefined) {
        // A Shared entry differs from the Library version: edited by hand, or the Library moved on.
        const modified = entryHash(existing) !== ours.written;
        if (modified && !discard.has(name)) {
          if (refresh.has(name)) throw new McpModifiedInRepo(name, file);
          status = "modifiedInRepo";
          write = false;
        } else if (!modified && !refresh.has(name)) {
          status = "outdated";
          write = false;
        }
      }
      if (write) {
        const format = formatOf(target.file);
        edits.push({
          file,
          change: `write ${at.join(".")}`,
          team: mode.committed,
          run: () => editConfigFile(target.file, (text) => format.write(text, at, written)),
        });
        delivered.push(mode.committed ? { ...entry, written: entryHash(written) } : entry);
      } else delivered.push(ours ?? entry);
      if (target.projectFile) filesByMode[wanted.mode].add(target.projectFile);
      if (mode.excluded && target.projectFile) excluded.add(target.projectFile);
      if (adapter.id === "claude-code" && mode.committed) claudeShared.now.add(name);
      const gate = await adapter.mcp.gate(project, env);
      deliveries.push({ agent: adapter.id, file, status, ...(gate && { approval: gate }) });
    }
    // Entries no longer wanted (Off, a mode switch, or an Agent dropped from the Project) go.
    for (const old of wanted.delivered)
      if (!delivered.some((kept) => sameAt(kept, old))) {
        await checkUnmodified(name, old);
        edits.push(removal(env, project, old));
      }

    next[name] = { ...wanted, delivered };
    servers.push({
      name,
      mode: wanted.mode,
      on: wanted.on,
      secrets: secretNames(definition),
      deliveries,
      ...(mode.committed && { envVars: [...sharedEnvVars(definition).keys()].sort() }),
    });
  }

  for (const file of filesByMode.shared)
    if (filesByMode.personal.has(file)) throw new McpFileShared(homeRelative(env.home, join(project, file)));

  // Claude Code loads a `.mcp.json` server only once you approve it: Dark Matter records your approval
  // in `.claude/settings.local.json` (per person), unless that file is committed.
  if (claudeShared.now.size > 0 || claudeShared.before.size > 0) {
    const settingsFile = join(project, CLAUDE_LOCAL_SETTINGS);
    const settingsRel = homeRelative(env.home, settingsFile);
    const tracked = await isTracked(project, CLAUDE_LOCAL_SETTINGS);
    const text = await readConfigText(settingsFile);
    const settings = (text === null ? {} : jsonc.read(text, settingsFile)) as Record<string, unknown>;
    const listed = Array.isArray(settings.enabledMcpjsonServers)
      ? settings.enabledMcpjsonServers.filter((item): item is string => typeof item === "string")
      : [];
    let approved = listed;
    if (!tracked) {
      for (const name of claudeShared.before)
        if (!claudeShared.now.has(name) && approved.includes(name)) {
          approved = approved.filter((item) => item !== name);
          const kept = approved;
          edits.push({
            file: settingsRel,
            change: `revoke ${name}`,
            team: false,
            run: () => editConfigFile(settingsFile, (current) => jsonc.set(current, ["enabledMcpjsonServers"], kept)),
          });
        }
      for (const name of claudeShared.now)
        if (!approved.includes(name)) {
          approved = [...approved, name];
          const kept = approved;
          edits.push({
            file: settingsRel,
            change: `approve ${name}`,
            team: false,
            run: () => editConfigFile(settingsFile, (current) => jsonc.set(current, ["enabledMcpjsonServers"], kept)),
          });
        }
      if (text !== null || claudeShared.now.size > 0) excluded.add(CLAUDE_LOCAL_SETTINGS);
    }
    const all = settings.enableAllProjectMcpServers === true;
    for (const server of servers)
      if (server.mode === "shared")
        for (const delivery of server.deliveries)
          if (delivery.agent === "claude-code" && delivery.status !== "off" && delivery.status !== "tracked")
            delivery.approval = all || approved.includes(server.name) ? "approved" : "needsApproval";
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
