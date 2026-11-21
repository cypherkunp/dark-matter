import {
  type ActivitySubject,
  type AddProjectMcpServer,
  type ClientKind,
  type CollectionMcpCell,
  InvalidOwnedFile,
  isTaggedError,
  type McpDefinition,
  type McpDeliveryMode,
  type McpEntryRef,
  McpModifiedInRepo,
  McpServerFile,
  McpServerNotFound,
  NameConflict,
  ProjectMcpServerNotFound,
  type ProjectMcpServerRecord,
  type ProjectMcpServers,
  ProjectNotFound,
  type ProjectRecord,
  type ProjectsFile,
  SecretInUse,
} from "@dark-matter/contracts";
import type { CoreServices } from "@dark-matter/contracts/router";
import type { ActivityLog, Wrote } from "./activity";
import { type AgentPathEnv, agentAdapters } from "./agents";
import { editConfigFile, readConfigText, toml } from "./config-edit";
import type { EventBus } from "./events";
import { fromHomeRelative, homeRelative } from "./home-path";
import { codexUserConfig, mcpConfigEdits } from "./mcp-agents";
import {
  applyMcpDelivery,
  entryHash,
  type McpPlanOptions,
  mcpDeliveryModes,
  planMcpDelivery,
  sharedDefinition,
  sharedEnvVars,
} from "./mcp-delivery";
import { definitionOf, type McpLibrary } from "./mcp-library";
import { secretNames } from "./mcp-secrets";
import type { OwnedFile } from "./owned-file";
import { type ProjectMcpFinding, projectMcpFindings, repoMcpServers } from "./repo-mcp";
import type { SecretStore } from "./secrets";
import { WriteQueue } from "./write-queue";

export interface ProjectMcpOptions {
  /** Where the Agents keep their files (review #15); `{ home }` when left out. */
  env?: AgentPathEnv;
  /** The core's one write queue (review #8); a queue of its own when left out (tests). */
  writes?: WriteQueue;
  home: string;
  mcp: McpLibrary;
  secrets: SecretStore;
  projects: OwnedFile<typeof ProjectsFile>;
  activity: ActivityLog;
  bus: EventBus;
}

/** The `project` procedures for Project MCP Servers. */
export type ProjectMcpProcedures = Pick<
  CoreServices["project"],
  | "mcpServers"
  | "mcpTargets"
  | "addMcpServers"
  | "setMcpServerOn"
  | "removeMcpServer"
  | "setMcpServerMode"
  | "mcpPlan"
  | "updateMcpServer"
  | "pullMcpServer"
  | "trustInCodex"
  | "repoMcpServers"
>;

/** The `mcp` procedures that rewrite Personal deliveries. */
export type McpRewriteProcedures = Pick<CoreServices["mcp"], "setSecret" | "updateDefinition" | "deleteSecret">;

/**
 * Project MCP Servers (#38): adding Library MCP Servers to Projects, On/Off and
 * Remove, plus the Library changes that rewrite Personal deliveries straight
 * away (a rotated Secret, an edited definition). Every change is "edit the
 * record, plan the whole Project, apply, save `mcpServers`", serialised.
 */
export class ProjectMcpService {
  readonly #ownWrites = new WriteQueue();

  constructor(private readonly options: ProjectMcpOptions) {}

  get #context() {
    const { mcp, secrets } = this.options;
    return { env: this.#env, mcp, secrets };
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    return (this.options.writes ?? this.#ownWrites).run(run);
  }

  /** Removing a Project's dry run, for MCP: Personal entries go, Shared ones stay committed. */
  releasePlan(path: string): { personalMcpServers: McpEntryRef[]; keptSharedMcpServers: McpEntryRef[] } {
    const servers = Object.entries(this.#record(path).mcpServers ?? {});
    const entries = (mode: string) =>
      servers
        .filter(([, server]) => server.mode === mode)
        .flatMap(([name, server]) => server.delivered.map((entry) => ({ name, file: entry.file })))
        .sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
    return { personalMcpServers: entries("personal"), keptSharedMcpServers: entries("shared") };
  }

  /**
   * Forgets every Project MCP Server of a Project (review #5): Personal entries
   * are removed from the Agents' configs; Shared ones stay in the committed
   * files for the team (from then on, Vendored).
   */
  forgetAll(path: string, wrote: Wrote): Promise<void> {
    return this.#serial(async () => {
      const record = this.options.projects.value.projects[path];
      const servers = record?.mcpServers ?? {};
      if (!record || Object.keys(servers).length === 0) return;
      const personal = Object.fromEntries(Object.entries(servers).filter(([, server]) => server.mode === "personal"));
      try {
        await this.#deliver(path, { ...record, mcpServers: {} }, wrote, personal);
      } finally {
        this.#changed();
      }
    });
  }

  get #env(): AgentPathEnv {
    return this.options.env ?? { home: this.options.home };
  }

  #record(path: string): ProjectRecord {
    const found = this.options.projects.value.projects[path];
    if (!found) throw new ProjectNotFound(path);
    return found;
  }

  /**
   * Delivers `next.mcpServers` into the Project and saves only that field, so a
   * concurrent Project Skill change to the same record isn't undone.
   */
  async #deliver(
    path: string,
    next: ProjectRecord,
    wrote: Wrote,
    removed: Record<string, ProjectMcpServerRecord> = {},
    options: McpPlanOptions = {},
  ) {
    const plan = await planMcpDelivery(this.#context, path, next, removed, options);
    await applyMcpDelivery(plan, wrote);
    wrote(
      await this.options.projects.update((file) => {
        const current = file.projects[path];
        if (!current) throw new ProjectNotFound(path);
        const { mcpServers: _old, ...rest } = current;
        const saved: ProjectRecord = plan.mcpServers ? { ...rest, mcpServers: plan.mcpServers } : rest;
        return { ...file, projects: { ...file.projects, [path]: saved } };
      }),
    );
    return plan.servers;
  }

  /** Re-delivers a Project's MCP Servers for its saved record (after its Agents change). */
  redeliver(path: string, wrote: Wrote) {
    return this.#serial(async () => {
      const record = this.#record(path);
      if (record.mcpServers) await this.#deliver(path, record, wrote);
    });
  }

  #changed() {
    this.options.bus.publish({ type: "invalidate", domains: ["project", "mcp"] });
  }

  #change<T>(client: ClientKind, action: string, subjects: ActivitySubject[], run: (wrote: Wrote) => Promise<T>) {
    return this.#serial(() =>
      this.options.activity.track({ client, action, subjects }, async (wrote) => {
        try {
          return await run(wrote);
        } finally {
          this.#changed();
        }
      }),
    );
  }

  #changeOne(
    client: ClientKind,
    action: string,
    path: string,
    name: string,
    edit: (
      record: ProjectRecord,
      current: ProjectMcpServerRecord,
    ) => { next: ProjectRecord; removed?: Record<string, ProjectMcpServerRecord>; options?: McpPlanOptions },
  ): Promise<ProjectMcpServers> {
    return this.#change(
      client,
      action,
      [
        { kind: "project", id: path },
        { kind: "mcpServer", id: name },
      ],
      async (wrote) => {
        const record = this.#record(path);
        const current = record.mcpServers?.[name];
        if (!current) throw new ProjectMcpServerNotFound(path, name);
        const { next, removed, options } = edit(record, current);
        return { path, servers: await this.#deliver(path, next, wrote, removed, options) };
      },
    );
  }

  /** Re-delivers every Project with an On Personal Project MCP Server that `affected` picks. */
  async #rewritePersonal(affected: (name: string) => boolean, wrote: Wrote) {
    for (const [path, record] of Object.entries(this.options.projects.value.projects).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const uses = Object.entries(record.mcpServers ?? {}).some(
        ([name, server]) => server.mode === "personal" && server.on && affected(name),
      );
      if (uses) await this.#deliver(path, record, wrote);
    }
  }

  /** Adds Library MCP Servers to Projects and delivers them On, planning every Project before any write. */
  async #add(servers: readonly AddProjectMcpServer[], wrote: Wrote): Promise<ProjectMcpServers[]> {
    const paths = [...new Set(servers.map((server) => server.path))];
    for (const { name } of servers) if (!(await this.options.mcp.read(name))) throw new McpServerNotFound(name);
    const nexts = paths.map((path) => {
      const record = this.#record(path);
      const added = Object.fromEntries(
        servers
          .filter((server) => server.path === path)
          .map((server): [string, ProjectMcpServerRecord] => {
            const current = record.mcpServers?.[server.name];
            return [
              server.name,
              { mode: server.mode ?? current?.mode ?? "personal", on: true, delivered: current?.delivered ?? [] },
            ];
          }),
      );
      return [path, { ...record, mcpServers: { ...record.mcpServers, ...added } }] as const;
    });
    // Plan every Project first, so a Name Conflict in one stops the lot before any write.
    for (const [path, next] of nexts) await planMcpDelivery(this.#context, path, next);
    const results: ProjectMcpServers[] = [];
    for (const [path, next] of nexts) results.push({ path, servers: await this.#deliver(path, next, wrote) });
    return results;
  }

  /**
   * Adding Collection MCP Servers (#41) to one Project, per item: "present",
   * "missing" (not in the Library, or its file is invalid), "blocked" (it
   * can't be delivered: a Name Conflict, a Secret not in the keychain, a
   * definition an Agent can't take) or "add". Writes nothing.
   */
  async preview(path: string, items: readonly { name: string; mode: McpDeliveryMode }[]): Promise<CollectionMcpCell[]> {
    const record = this.#record(path);
    const cells: CollectionMcpCell[] = [];
    for (const { name, mode } of items) {
      const cell: CollectionMcpCell = { path, name, mode, outcome: "add", blockedBy: null, problem: null };
      const current = record.mcpServers?.[name];
      if (!(await this.options.mcp.read(name))?.value) cells.push({ ...cell, outcome: "missing" });
      else if (current) cells.push({ ...cell, mode: current.mode, outcome: "present" });
      else {
        const alone = { ...record, mcpServers: { ...record.mcpServers, [name]: { mode, on: true, delivered: [] } } };
        try {
          await planMcpDelivery(this.#context, path, alone);
          cells.push(cell);
        } catch (error) {
          if (!isTaggedError(error)) throw error;
          const blockedBy = error instanceof NameConflict ? (error.path ?? null) : null;
          cells.push({ ...cell, outcome: "blocked", blockedBy, problem: error.message });
        }
      }
    }
    return cells;
  }

  /**
   * Applies a Collection's MCP Servers (#41): adds what each Project can take
   * and reports every item's outcome. The caller records the Activity entry.
   */
  applyCollection(servers: readonly AddProjectMcpServer[], wrote: Wrote) {
    const paths = [...new Set(servers.map((server) => server.path))];
    return this.#serial(async () => {
      try {
        const cells: CollectionMcpCell[] = [];
        for (const path of paths) {
          const own = servers.filter((server) => server.path === path);
          cells.push(
            ...(await this.preview(
              path,
              own.map(({ name, mode }) => ({ name, mode: mode ?? "personal" })),
            )),
          );
        }
        const adding = cells
          .filter((cell) => cell.outcome === "add")
          .map(({ path, name, mode }) => ({ path, name, mode }));
        const projects = adding.length > 0 ? await this.#add(adding, wrote) : [];
        return { projects, cells };
      } finally {
        this.#changed();
      }
    });
  }

  services(): ProjectMcpProcedures {
    const { home } = this.options;
    return {
      mcpServers: async (path) => (await planMcpDelivery(this.#context, path, this.#record(path))).servers,

      mcpTargets: async (path) => {
        const { agents } = this.#record(path);
        const targets = [];
        for (const adapter of agentAdapters) {
          if (!agents.includes(adapter.id) || !adapter.mcp) continue;
          const target = await mcpDeliveryModes.personal.target(adapter.mcp, path, this.#env);
          targets.push({
            agent: adapter.id,
            file: homeRelative(home, target.file),
            personal: await mcpDeliveryModes.personal.offered(target, path),
            shared: homeRelative(home, (await mcpDeliveryModes.shared.target(adapter.mcp, path, this.#env)).file),
          });
        }
        return targets;
      },

      addMcpServers: ({ servers }, client) => {
        const paths = [...new Set(servers.map((server) => server.path))];
        const subjects: ActivitySubject[] = [
          ...paths.map((id) => ({ kind: "project" as const, id })),
          ...[...new Set(servers.map((server) => server.name))].map((id) => ({ kind: "mcpServer" as const, id })),
        ];
        return this.#change(client, "project.addMcpServers", subjects, (wrote) => this.#add(servers, wrote));
      },

      setMcpServerOn: ({ path, name, on, discardEdits }, client) =>
        this.#changeOne(client, on ? "project.mcpServerOn" : "project.mcpServerOff", path, name, (record, current) => ({
          next: { ...record, mcpServers: { ...record.mcpServers, [name]: { ...current, on } } },
          options: { discard: discardEdits ? [name] : [] },
        })),

      removeMcpServer: ({ path, name, discardEdits }, client) =>
        this.#changeOne(client, "project.removeMcpServer", path, name, (record, current) => {
          const { [name]: _gone, ...rest } = record.mcpServers ?? {};
          return {
            next: { ...record, mcpServers: rest },
            removed: { [name]: current },
            options: { discard: discardEdits ? [name] : [] },
          };
        }),

      setMcpServerMode: ({ path, name, mode, discardEdits }, client) =>
        this.#changeOne(client, "project.mcpServerMode", path, name, (record, current) => ({
          next: { ...record, mcpServers: { ...record.mcpServers, [name]: { ...current, mode } } },
          options: { refresh: [name], discard: discardEdits ? [name] : [] },
        })),

      mcpPlan: async ({ path, name, mode, on, remove, update, discardEdits }) => {
        if (!(await this.options.mcp.read(name))) throw new McpServerNotFound(name);
        const record = this.#record(path);
        const current = record.mcpServers?.[name];
        if ((remove || update) && !current) throw new ProjectMcpServerNotFound(path, name);
        const { [name]: _changed, ...others } = record.mcpServers ?? {};
        const nextMode = mode ?? current?.mode ?? "personal";
        const next: ProjectRecord = remove
          ? { ...record, mcpServers: others }
          : {
              ...record,
              mcpServers: {
                ...others,
                [name]: { mode: nextMode, on: on ?? current?.on ?? true, delivered: current?.delivered ?? [] },
              },
            };
        const plan = await planMcpDelivery(this.#context, path, next, remove && current ? { [name]: current } : {}, {
          refresh: update || (current && nextMode !== current.mode) ? [name] : [],
          discard: discardEdits ? [name] : [],
        });
        const server = plan.servers.find((found) => found.name === name);
        return {
          edits: plan.edits.map(({ file, change }) => ({ file, change })),
          envVars: server?.envVars ?? [],
          teamChange: plan.edits.some((edit) => edit.team),
        };
      },

      updateMcpServer: ({ path, name, discardEdits }, client) =>
        this.#changeOne(client, "project.updateMcpServer", path, name, (record) => ({
          next: record,
          options: { refresh: [name], discard: discardEdits ? [name] : [] },
        })),

      pullMcpServer: ({ path, name, agent }, client) =>
        this.#change(
          client,
          "project.pullMcpServer",
          [
            { kind: "project", id: path },
            { kind: "mcpServer", id: name },
          ],
          async (wrote) => {
            const record = this.#record(path);
            const current = record.mcpServers?.[name];
            if (!current) throw new ProjectMcpServerNotFound(path, name);
            const delivered = current.delivered.find((entry) => entry.agent === agent);
            const adapter = agentAdapters.find((candidate) => candidate.id === agent)?.mcp;
            if (!delivered || !adapter) throw new ProjectMcpServerNotFound(path, name);
            const file = fromHomeRelative(home, delivered.file);
            const text = (await readConfigText(file)) ?? "";
            const raw = lookupAt(mcpConfigEdits[adapter.format].read(text, file), delivered.at);
            const pulled = isRecord(raw) ? adapter.read(raw) : null;
            if (!pulled || (delivered.written !== undefined && entryHash(raw) === delivered.written)) {
              throw new McpModifiedInRepo(name, delivered.file);
            }
            const stored = await this.#stored(name);
            // Env vars that stand for Secrets go back to `${secret:…}` references: no value enters the Library.
            const secretOf = sharedEnvVars(definitionOf(stored));
            const back = (value: string) =>
              value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (ref, variable: string) => {
                const secret = secretOf.get(variable);
                return secret ? `\${secret:${secret}}` : ref;
              });
            // An env or header value still as Dark Matter wrote it goes back to the Library's own value (story 98
            // turned literals into references too), so pulling never loses a literal or a Secret reference.
            const original = definitionOf(stored);
            const written = sharedDefinition(original);
            const restore = (
              pulledValues: Record<string, string> | undefined,
              writtenValues: Record<string, string> | undefined,
              originalValues: Record<string, string> | undefined,
            ) =>
              pulledValues &&
              Object.fromEntries(
                Object.entries(pulledValues).map(([key, value]) =>
                  writtenValues?.[key] === value && originalValues?.[key] !== undefined
                    ? [key, originalValues[key]]
                    : [key, back(value)],
                ),
              );
            const mapped = mapStrings(pulled, back);
            const env = restore(pulled.env, written.env, original.env);
            const headers = restore(pulled.headers, written.headers, original.headers);
            const definition = { ...mapped, ...(env && { env }), ...(headers && { headers }) };
            await this.#saveDefinition(name, stored, definition, wrote);
            await this.#rewritePersonal((server) => server === name, wrote);
            // The edit is in the Library now; the entry is rewritten from it (a literal becomes a reference).
            return {
              path,
              servers: await this.#deliver(path, this.#record(path), wrote, {}, { refresh: [name], discard: [name] }),
            };
          },
        ),

      repoMcpServers: async (path) => repoMcpServers(this.#env, path, this.#record(path)),

      trustInCodex: (path, client) =>
        this.#change(client, "project.trustInCodex", [{ kind: "project", id: path }], async (wrote) => {
          const record = this.#record(path);
          const written = await editConfigFile(codexUserConfig(this.#env), (text) =>
            toml.set(text, ["projects", path], "trust_level", "trusted"),
          );
          if (written) wrote(written);
          return { path, servers: (await planMcpDelivery(this.#context, path, record)).servers };
        }),
    };
  }

  async #stored(name: string) {
    const stored = await this.options.mcp.read(name);
    if (!stored) throw new McpServerNotFound(name);
    if (!stored.value) throw new InvalidOwnedFile(stored.path, stored.problem ?? "invalid");
    return stored.value;
  }

  async #saveDefinition(name: string, stored: McpServerFile, definition: McpDefinition, wrote: Wrote) {
    const { adoptedFrom } = stored;
    wrote(
      await this.options.mcp.write(name, McpServerFile.parse({ ...definition, ...(adoptedFrom && { adoptedFrom }) })),
    );
  }

  /** Every untracked or Vendored MCP entry in every Project, for Adopt (#39). */
  async findings(): Promise<ProjectMcpFinding[]> {
    const found: ProjectMcpFinding[] = [];
    for (const [path, record] of Object.entries(this.options.projects.value.projects))
      found.push(...(await projectMcpFindings(this.#env, path, record)));
    return found;
  }

  /**
   * Adopt of an untracked or Claude local-scope entry (#39) puts it back as a
   * Personal Project MCP Server, On, so nothing changes for the Agent.
   */
  keepPersonal(path: string, name: string, wrote: Wrote) {
    return this.#serial(async () => {
      const record = this.#record(path);
      const current = record.mcpServers?.[name];
      const next: ProjectRecord = {
        ...record,
        mcpServers: {
          ...record.mcpServers,
          [name]: { mode: "personal", on: true, delivered: current?.delivered ?? [] },
        },
      };
      await this.#deliver(path, next, wrote);
      this.#changed();
    });
  }

  /** Undo Adopt: the Project forgets a server it kept as Personal, and its entries go. */
  release(path: string, name: string, wrote: Wrote) {
    return this.#serial(async () => {
      const record = this.options.projects.value.projects[path];
      const current = record?.mcpServers?.[name];
      if (!record || !current) return;
      const { [name]: _gone, ...rest } = record.mcpServers ?? {};
      await this.#deliver(path, { ...record, mcpServers: rest }, wrote, { [name]: current });
      this.#changed();
    });
  }

  /** Secrets and definitions: changing either rewrites Personal deliveries straight away. */
  mcpServices(): McpRewriteProcedures {
    const { mcp, secrets } = this.options;
    const usersOf = async (secret: string) =>
      (await mcp.all()).filter((stored) => stored.value && secretNames(definitionOf(stored.value)).includes(secret));
    return {
      setSecret: async ({ name, value }, client) => {
        const users = (await usersOf(name)).map((stored) => stored.name);
        return this.#change(
          client,
          "mcp.setSecret",
          users.map((id) => ({ kind: "mcpServer" as const, id })),
          async (wrote) => {
            await secrets.set(name, value);
            await this.#rewritePersonal((server) => users.includes(server), wrote);
          },
        );
      },

      // Shared deliveries are left as they are: they show as outdated until each Project updates.
      updateDefinition: ({ name, definition }, client) =>
        this.#change(client, "mcp.updateDefinition", [{ kind: "mcpServer", id: name }], async (wrote) => {
          await this.#saveDefinition(name, await this.#stored(name), definition, wrote);
          await this.#rewritePersonal((server) => server === name, wrote);
        }),

      deleteSecret: async ({ name }, client) => {
        const users = (await usersOf(name)).map((stored) => stored.name);
        return this.#change(
          client,
          "mcp.deleteSecret",
          users.map((id) => ({ kind: "mcpServer" as const, id })),
          async () => {
            const delivering = new Set<string>();
            for (const record of Object.values(this.options.projects.value.projects))
              for (const [server, wanted] of Object.entries(record.mcpServers ?? {}))
                if (users.includes(server) && wanted.mode === "personal" && wanted.on) delivering.add(server);
            if (delivering.size > 0) throw new SecretInUse(name, [...delivering].sort());
            await secrets.delete(name);
          },
        );
      },
    };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const lookupAt = (doc: unknown, at: readonly string[]): unknown =>
  at.reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), doc);

/** The definition with `fn` applied to every string value. */
const mapStrings = (definition: McpDefinition, fn: (value: string) => string): McpDefinition => {
  const map = (values: Record<string, string> | undefined) =>
    values && Object.fromEntries(Object.entries(values).map(([key, value]) => [key, fn(value)]));
  return {
    ...definition,
    ...(definition.command !== undefined && { command: fn(definition.command) }),
    ...(definition.args && { args: definition.args.map(fn) }),
    ...(definition.env && { env: map(definition.env) }),
    ...(definition.cwd !== undefined && { cwd: fn(definition.cwd) }),
    ...(definition.url !== undefined && { url: fn(definition.url) }),
    ...(definition.headers && { headers: map(definition.headers) }),
  };
};
