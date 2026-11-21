import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type ClientKind,
  FindingNotFound,
  InvalidOwnedFile,
  type LibraryMcpServer,
  type McpAdoptedFrom,
  type McpAdoptOutcome,
  type McpAdoptPlan,
  type McpAdoptPlanServer,
  type McpDefinition,
  McpServerFile,
  McpServerNotFound,
  NameConflict,
  NotAdopted,
  PlanStale,
  type PlanStep,
  type ScanResult,
  SecretMissing,
} from "@dark-matter/contracts";
import type { ActivityLog, Wrote } from "./activity";
import { type AgentPathEnv, agentAdapters } from "./agents";
import { writeFileAtomic } from "./atomic";
import { editConfigFile, readConfigText } from "./config-edit";
import { fromHomeRelative, homeRelative } from "./home-path";
import { type McpEntry, mcpConfigEdits, readGlobalMcp } from "./mcp-agents";
import { type InlineSecret, maskSecrets, secretNames } from "./mcp-secrets";
import { applySteps, planId } from "./plan";
import type { ProjectMcpFinding } from "./repo-mcp";
import type { SecretStore } from "./secrets";
import { diffSkillFiles } from "./skill-diff";
import { toSortedJson } from "./sorted-json";
import { WriteQueue } from "./write-queue";

const VISIBILITY_WARNING = (count: number) =>
  `${count === 1 ? "This MCP Server stops" : `These ${count} MCP Servers stop`} loading in every Project. ` +
  "Agents see a Library MCP Server again only when a Project adds it.";

/** One file under `mcp/`, read now. */
interface Stored {
  name: string;
  path: string;
  value: McpServerFile | null;
  problem: string | null;
}

/**
 * Library MCP Servers (ADR-0005): one owned JSON file per server at
 * `~/.dark-matter/mcp/<name>.json`, flat by name with no Namespace. Files hold
 * Secret names only. They're read on demand; a hand edit that doesn't validate
 * is listed with its problem and never overwritten.
 */
export class McpLibrary {
  readonly dir: string;
  /** Each file's last valid contents: a held hand edit keeps serving it (#42). */
  readonly #lastGood = new Map<string, McpServerFile>();

  constructor(libraryHome: string) {
    this.dir = join(libraryHome, "mcp");
  }

  path(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  async read(name: string): Promise<Stored | null> {
    const path = this.path(name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const held = (problem: string): Stored => ({ name, path, value: this.#lastGood.get(name) ?? null, problem });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return held(`not valid JSON (${(error as Error).message})`);
    }
    const parsed = McpServerFile.safeParse(json);
    if (!parsed.success) return held(parsed.error.issues.map((issue) => issue.message).join("; "));
    this.#lastGood.set(name, parsed.data);
    return { name, path, value: parsed.data, problem: null };
  }

  async all(): Promise<Stored[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const stored = await Promise.all(
      names
        .filter((file) => file.endsWith(".json") && !file.startsWith("."))
        .map((file) => this.read(file.slice(0, -".json".length))),
    );
    return stored.filter((entry): entry is Stored => entry !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every Library MCP Server; with `secrets`, which of their Secrets are missing from the keychain. */
  async list(home: string, secrets?: SecretStore): Promise<LibraryMcpServer[]> {
    const listed = (await this.all()).map(async ({ name, path, value, problem }) => {
      const definition = value ? definitionOf(value) : null;
      const names = definition ? secretNames(definition) : [];
      const missing = [];
      if (secrets)
        for (const secret of names) if ((await secrets.get(secret).catch(() => null)) === null) missing.push(secret);
      return {
        name,
        definition,
        secrets: names,
        missingSecrets: missing,
        adoptedFrom: (value?.adoptedFrom ?? []).map(({ agent, file }) => ({ agent, file })),
        file: homeRelative(home, path),
        problem,
      };
    });
    return Promise.all(listed);
  }

  /** Writes a definition file atomically, keys sorted. A held hand edit is never overwritten. */
  async write(name: string, value: McpServerFile): Promise<string> {
    const current = await this.read(name);
    if (current?.problem) throw new InvalidOwnedFile(current.path, current.problem);
    await mkdir(this.dir, { recursive: true });
    const path = this.path(name);
    const parsed = McpServerFile.parse(value);
    await writeFileAtomic(path, toSortedJson(parsed));
    this.#lastGood.set(name, parsed);
    return path;
  }
}

export const definitionOf = ({ adoptedFrom: _adoptedFrom, ...definition }: McpServerFile): McpDefinition => definition;

/** Replaces every occurrence of each Secret's value in the entry's strings with its reference, or back. */
const swapStrings = (value: unknown, swap: (text: string) => string): unknown => {
  if (typeof value === "string") return swap(value);
  if (Array.isArray(value)) return value.map((item) => swapStrings(item, swap));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, swapStrings(inner, swap)]));
  return value;
};

const hideSecrets = (raw: unknown, secrets: readonly InlineSecret[]) => {
  const longestFirst = [...secrets].sort((a, b) => b.value.length - a.value.length);
  return swapStrings(raw, (text) =>
    longestFirst.reduce((out, secret) => out.split(secret.value).join(`\${secret:${secret.name}}`), text),
  );
};

/** Fills `${secret:NAME}` references from the keychain; a missing one throws `SecretMissing`. */
export const fillSecrets = async (value: unknown, secrets: SecretStore): Promise<unknown> => {
  const names = new Set<string>();
  swapStrings(value, (text) => {
    for (const match of text.matchAll(/\$\{secret:([^}]+)\}/g)) names.add(match[1] ?? "");
    return text;
  });
  const values = new Map<string, string>();
  for (const name of names) {
    const secret = await secrets.get(name);
    if (secret === null) throw new SecretMissing(name);
    values.set(name, secret);
  }
  return swapStrings(value, (text) =>
    text.replace(/\$\{secret:([^}]+)\}/g, (_ref, name: string) => values.get(name) ?? ""),
  );
};

const sameDefinition = (a: McpDefinition, b: McpDefinition) => toSortedJson(a) === toSortedJson(b);

/** A Library MCP Server some planned server is compared with: by its definition with Secrets filled in. */
interface Known {
  name: string;
  masked: McpDefinition;
  /** Null when a Secret it refers to is missing, so nothing can be identical to it. */
  real: McpDefinition | null;
  file: McpServerFile;
  isNew: boolean;
}

interface Planned {
  plan: McpAdoptPlan;
  /** What each `editFile` and `storeSecret` step does, by step. */
  actions: Map<string, () => Promise<string | string[] | null>>;
}

const stepKey = (step: PlanStep) => toSortedJson(step);

export interface McpAdoptOptions {
  /** Where the Agents keep their files (review #15); `{ home }` when left out. */
  env?: AgentPathEnv;
  /** The core's one write queue (review #8); a queue of its own when left out (tests). */
  writes?: WriteQueue;
  home: string;
  libraryHome: string;
  mcp: McpLibrary;
  secrets: SecretStore;
  activity: ActivityLog;
  latestScan: () => ScanResult | null;
  rescan: () => Promise<unknown>;
  onChange: () => void;
  /** Untracked and Claude local-scope entries in Projects (#39), Adopted by their `project-mcp:` ids. */
  projectFindings?: () => Promise<ProjectMcpFinding[]>;
  /** Puts an Adopted Project entry back as Personal, and releases it on Undo (#39). */
  keepPersonal?: {
    keep(project: string, name: string, wrote: Wrote): Promise<void>;
    release(project: string, name: string, wrote: Wrote): Promise<void>;
  };
}

/**
 * Adopt for Global MCP Servers (#37): moves an Agent's global entry into the
 * Library as an Agent-neutral definition, inline secrets into the keychain,
 * and removes the entry with a targeted, format-preserving edit. Same name
 * and definition merge into one Library MCP Server; a different definition
 * becomes a variant you name. Undo puts every entry back.
 */
export class McpAdopt {
  readonly #options: McpAdoptOptions;
  readonly #ownWrites = new WriteQueue();

  constructor(options: McpAdoptOptions) {
    this.#options = options;
  }

  async plan(findings: string[], names: Record<string, string> = {}): Promise<McpAdoptPlan> {
    return (await this.#plan(findings, names)).plan;
  }

  apply(findings: string[], names: Record<string, string> = {}, expected: string, client: ClientKind) {
    return this.#serial(async () => {
      const { plan, actions } = await this.#plan(findings, names);
      return this.#options.activity.track(
        {
          client,
          action: "mcp.adopt",
          subjects: [...new Set(plan.servers.map((server) => server.libraryName))].map((id) => ({
            kind: "mcpServer" as const,
            id,
          })),
        },
        async (wrote) => {
          if (plan.planId !== expected) throw new PlanStale();
          await this.#run(plan.steps, actions, wrote);
          this.#options.onChange();
          await this.#options.rescan();
          return plan;
        },
      );
    });
  }

  undo(name: string, client: ClientKind): Promise<void> {
    return this.#serial(() =>
      this.#options.activity.track(
        { client, action: "mcp.undoAdopt", subjects: [{ kind: "mcpServer", id: name }] },
        async (wrote) => {
          const { home, mcp, secrets } = this.#options;
          const stored = await mcp.read(name);
          if (!stored) throw new McpServerNotFound(name);
          if (stored.problem || !stored.value) throw new InvalidOwnedFile(stored.path, stored.problem ?? "invalid");
          const from = stored.value.adoptedFrom ?? [];
          if (from.length === 0) throw new NotAdopted(name);
          // A Project entry kept as Personal goes first, so the original can go back in its place.
          for (const origin of from)
            if (origin.project) await this.#options.keepPersonal?.release(origin.project, name, wrote);
          const steps: PlanStep[] = [];
          const actions = new Map<string, () => Promise<string | string[] | null>>();
          const add = (step: PlanStep, action: () => Promise<string | string[] | null>) => {
            steps.push(step);
            actions.set(stepKey(step), action);
          };
          for (const origin of from) {
            const mcpOf = agentAdapters.find((adapter) => adapter.id === origin.agent)?.mcp;
            if (!mcpOf) throw new NotAdopted(name);
            const file = fromHomeRelative(home, origin.file);
            const current = await readConfigText(file);
            if (lookupAt(mcpConfigEdits[mcpOf.format].read(current ?? "", file), origin.at) !== undefined) {
              throw new NameConflict([origin.at.at(-1) ?? name], `${origin.file} › ${origin.at.join(".")}`);
            }
            const raw = (await fillSecrets(origin.entry, secrets)) as Record<string, unknown>;
            add({ kind: "editFile", path: origin.file, change: `restore ${origin.at.join(".")}` }, () =>
              editConfigFile(file, (text) => mcpConfigEdits[mcpOf.format].restore(text, origin.at, raw)),
            );
          }
          add({ kind: "editFile", path: homeRelative(home, stored.path), change: "remove" }, async () => {
            await rm(stored.path);
            return stored.path;
          });
          const stillUsed = new Set(
            (await mcp.all())
              .filter((other) => other.name !== name && other.value)
              .flatMap((other) => (other.value ? secretNames(definitionOf(other.value)) : [])),
          );
          for (const secret of secretNames(definitionOf(stored.value))) {
            if (stillUsed.has(secret)) continue;
            add({ kind: "deleteSecret", name: secret }, async () => {
              await secrets.delete(secret);
              return null;
            });
          }
          await this.#run(steps, actions, wrote);
          this.#options.onChange();
          await this.#options.rescan();
        },
      ),
    );
  }

  async #run(
    steps: PlanStep[],
    actions: Map<string, () => Promise<string | string[] | null>>,
    wrote: (path: string | null) => void,
  ) {
    const act = async (step: PlanStep) => {
      const action = actions.get(stepKey(step));
      if (!action) throw new PlanStale();
      return action();
    };
    await applySteps(steps, {
      home: this.#options.home,
      libraryHome: this.#options.libraryHome,
      wrote,
      editFile: async (step) => {
        const path = await act(step);
        return Array.isArray(path) ? path : path ? [path] : [];
      },
      secret: async (step) => void (await act(step)),
    });
  }

  async #plan(ids: string[], names: Record<string, string>): Promise<Planned> {
    const { home, mcp, secrets } = this.#options;
    const env: AgentPathEnv = this.#options.env ?? { home };
    const scan = this.#options.latestScan();
    const inProjects = ids.some((id) => id.startsWith("project-mcp:"))
      ? ((await this.#options.projectFindings?.()) ?? []).filter((finding) => !finding.tracked)
      : [];
    const findings = [...new Set(ids)].map((id) => {
      const finding = scan?.globalMcpServers.find((server) => server.id === id);
      const inProject = inProjects.find((candidate) => candidate.id === id);
      if (finding) return { id, agent: finding.agent, name: finding.name, project: null };
      if (inProject) return { id, agent: inProject.agent, name: inProject.entry.name, project: inProject };
      throw new FindingNotFound(id);
    });

    // Every Library MCP Server, compared by its definition with Secrets filled in.
    const known = new Map<string, Known>();
    for (const stored of await mcp.all()) {
      if (stored.problem || !stored.value) {
        // A held hand edit still takes its name.
        known.set(stored.name, {
          name: stored.name,
          masked: { transport: "stdio" },
          real: null,
          file: { transport: "stdio" },
          isNew: false,
        });
        continue;
      }
      const masked = definitionOf(stored.value);
      const real = (await fillSecrets(masked, secrets).catch(() => null)) as McpDefinition | null;
      known.set(stored.name, { name: stored.name, masked, real, file: stored.value, isNew: false });
    }

    const configs = new Map<string, Awaited<ReturnType<typeof readGlobalMcp>>>();
    const servers: McpAdoptPlanServer[] = [];
    const removals: { step: PlanStep; action: () => Promise<string | string[] | null> }[] = [];
    const keptBack: { step: PlanStep; action: () => Promise<string[]> }[] = [];
    const secretValues = new Map<string, string>();
    const touched = new Set<string>();
    const digest = createHash("sha256");

    for (const finding of findings) {
      const adapter = agentAdapters.find((candidate) => candidate.id === finding.agent);
      const mcpOf = adapter?.mcp;
      if (!mcpOf) throw new FindingNotFound(finding.id);
      let config = { file: finding.project?.file ?? "", entries: finding.project ? [finding.project.entry] : [] };
      if (!finding.project) {
        const global = configs.get(finding.agent) ?? (await readGlobalMcp(mcpOf, env));
        configs.set(finding.agent, global);
        if (global.problem) throw new InvalidOwnedFile(global.file, global.problem);
        config = global;
      }
      const entry: McpEntry | undefined = config.entries.find((candidate) => candidate.name === finding.name);
      if (!entry) throw new PlanStale();
      digest.update(toSortedJson(entry.raw));

      const chosen = names[finding.id];
      const base = known.get(entry.name);
      const { libraryName, outcome } = this.#name(entry, finding.agent, chosen, known);
      const masked = maskSecrets(libraryName, entry.definition);
      const into = known.get(libraryName);
      const adoption: McpAdoptedFrom = {
        agent: finding.agent,
        file: homeRelative(home, config.file),
        at: entry.at,
        entry: hideSecrets(entry.raw, masked.secrets),
        ...(finding.project && { project: finding.project.project }),
      };
      if (outcome === "merged" && into) {
        into.file = { ...into.file, adoptedFrom: [...(into.file.adoptedFrom ?? []), adoption] };
      } else {
        for (const secret of masked.secrets) secretValues.set(secret.name, secret.value);
        known.set(libraryName, {
          name: libraryName,
          masked: masked.definition,
          real: entry.definition,
          file: { ...masked.definition, adoptedFrom: [adoption] },
          isNew: true,
        });
      }
      touched.add(libraryName);
      servers.push({
        finding: finding.id,
        agent: finding.agent,
        name: entry.name,
        libraryName,
        outcome,
        secrets: outcome === "merged" ? [] : masked.secrets.map((secret) => secret.name),
        diff:
          outcome === "variant" && base
            ? {
                against: base.name,
                patch: diffSkillFiles(
                  [{ path: `${base.name}.json`, content: Buffer.from(toSortedJson(base.masked)) }],
                  [{ path: `${libraryName}.json`, content: Buffer.from(toSortedJson(masked.definition)) }],
                  { a: base.name, b: libraryName },
                ),
              }
            : null,
      });
      const file = config.file;
      removals.push({
        step: { kind: "editFile", path: homeRelative(home, file), change: `remove ${entry.at.join(".")}` },
        action: () => editConfigFile(file, (text) => mcpConfigEdits[mcpOf.format].remove(text, entry.at)),
      });
      const keep = this.#options.keepPersonal;
      const project = finding.project?.project;
      if (keep && project) {
        // Back as a Personal Project MCP Server, so nothing changes for the Agent.
        keptBack.push({
          step: {
            kind: "editFile",
            path: homeRelative(home, file),
            change: `put ${libraryName} back as Personal in ${homeRelative(home, project)}`,
          },
          action: async () => {
            const files: string[] = [];
            await keep.keep(project, libraryName, (path) => {
              if (path) files.push(path);
            });
            return files;
          },
        });
      }
    }

    const steps: PlanStep[] = [];
    const actions = new Map<string, () => Promise<string | string[] | null>>();
    const add = (step: PlanStep, action: () => Promise<string | string[] | null>) => {
      steps.push(step);
      actions.set(stepKey(step), action);
    };
    for (const [name, value] of [...secretValues].sort(([a], [b]) => a.localeCompare(b))) {
      digest.update(`${name}\0${value}\0`);
      add({ kind: "storeSecret", name }, async () => {
        await secrets.set(name, value);
        return null;
      });
    }
    const files: Record<string, McpServerFile> = {};
    for (const name of [...touched].sort()) {
      const server = known.get(name);
      if (!server) continue;
      files[name] = server.file;
      const path = mcp.path(name);
      add(
        {
          kind: "editFile",
          path: homeRelative(home, path),
          change: server.isNew ? "create" : `record ${server.file.adoptedFrom?.length ?? 0} adoptions`,
        },
        async () => {
          if (server.isNew && (await exists(path))) throw new NameConflict([name]);
          return mcp.write(name, server.file);
        },
      );
    }
    for (const removal of removals) add(removal.step, removal.action);
    for (const kept of keptBack) add(kept.step, kept.action);

    const body = {
      findings: findings.map((finding) => finding.id),
      servers,
      steps,
      warnings: [VISIBILITY_WARNING(touched.size)],
    };
    return { plan: { planId: planId({ ...body, files, digest: digest.digest("hex") }), ...body }, actions };
  }

  /** Where one server goes: its own name, merged into an identical one, or a variant name. */
  #name(entry: McpEntry, agent: string, chosen: string | undefined, known: Map<string, Known>) {
    const fits = (name: string) => {
      const other = known.get(name);
      if (!other) return "free" as const;
      return other.real && sameDefinition(other.real, entry.definition) ? ("same" as const) : ("taken" as const);
    };
    const base = fits(entry.name);
    const variantOf = (fit: "free" | "same"): McpAdoptOutcome =>
      fit === "same" ? "merged" : base === "taken" ? "variant" : "moved";
    if (chosen) {
      const fit = fits(chosen);
      if (fit === "taken") throw new NameConflict([chosen]);
      return { libraryName: chosen, outcome: variantOf(fit) };
    }
    if (base !== "taken") return { libraryName: entry.name, outcome: variantOf(base) };
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? `${entry.name}-${agent}` : `${entry.name}-${agent}-${n}`;
      const fit = fits(candidate);
      if (fit !== "taken") return { libraryName: candidate, outcome: variantOf(fit) };
    }
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    return (this.#options.writes ?? this.#ownWrites).run(task);
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const lookupAt = (doc: unknown, at: readonly string[]): unknown =>
  at.reduce<unknown>(
    (value, key) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined),
    doc,
  );
