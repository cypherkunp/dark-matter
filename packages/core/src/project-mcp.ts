import {
  type ActivitySubject,
  type ClientKind,
  InvalidOwnedFile,
  McpServerFile,
  McpServerNotFound,
  ProjectMcpServerNotFound,
  type ProjectMcpServerRecord,
  type ProjectMcpServers,
  ProjectNotFound,
  type ProjectRecord,
  type ProjectsFile,
} from "@dark-matter/contracts";
import type { CoreServices } from "@dark-matter/contracts/router";
import type { ActivityLog, Wrote } from "./activity";
import { agentAdapters } from "./agents";
import type { EventBus } from "./events";
import { homeRelative } from "./home-path";
import { applyMcpDelivery, mcpDeliveryModes, planMcpDelivery } from "./mcp-delivery";
import { definitionOf, type McpLibrary } from "./mcp-library";
import { secretNames } from "./mcp-secrets";
import type { OwnedFile } from "./owned-file";
import type { SecretStore } from "./secrets";

export interface ProjectMcpOptions {
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
  "mcpServers" | "mcpTargets" | "addMcpServers" | "setMcpServerOn" | "removeMcpServer"
>;

/** The `mcp` procedures that rewrite Personal deliveries. */
export type McpRewriteProcedures = Pick<CoreServices["mcp"], "setSecret" | "updateDefinition">;

/**
 * Project MCP Servers (#38): adding Library MCP Servers to Projects, On/Off and
 * Remove, plus the Library changes that rewrite Personal deliveries straight
 * away (a rotated Secret, an edited definition). Every change is "edit the
 * record, plan the whole Project, apply, save `mcpServers`", serialised.
 */
export class ProjectMcpService {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ProjectMcpOptions) {}

  get #context() {
    const { home, mcp, secrets } = this.options;
    return { env: { home }, mcp, secrets };
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
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
  async #deliver(path: string, next: ProjectRecord, wrote: Wrote, removed: ProjectMcpServerRecord[] = []) {
    const plan = await planMcpDelivery(this.#context, path, next, removed);
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
    ) => { next: ProjectRecord; removed?: ProjectMcpServerRecord[] },
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
        const { next, removed } = edit(record, current);
        return { path, servers: await this.#deliver(path, next, wrote, removed) };
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

  services(): ProjectMcpProcedures {
    const { home } = this.options;
    return {
      mcpServers: async (path) => (await planMcpDelivery(this.#context, path, this.#record(path))).servers,

      mcpTargets: async (path) => {
        const { agents } = this.#record(path);
        const targets = [];
        for (const adapter of agentAdapters) {
          if (!agents.includes(adapter.id) || !adapter.mcp) continue;
          const target = await mcpDeliveryModes.personal.target(adapter.mcp, path, { home });
          targets.push({
            agent: adapter.id,
            file: homeRelative(home, target.file),
            personal: await mcpDeliveryModes.personal.offered(target, path),
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
        return this.#change(client, "project.addMcpServers", subjects, async (wrote) => {
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
        });
      },

      setMcpServerOn: ({ path, name, on }, client) =>
        this.#changeOne(client, on ? "project.mcpServerOn" : "project.mcpServerOff", path, name, (record, current) => ({
          next: { ...record, mcpServers: { ...record.mcpServers, [name]: { ...current, on } } },
        })),

      removeMcpServer: ({ path, name }, client) =>
        this.#changeOne(client, "project.removeMcpServer", path, name, (record, current) => {
          const { [name]: _gone, ...rest } = record.mcpServers ?? {};
          return { next: { ...record, mcpServers: rest }, removed: [current] };
        }),
    };
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

      updateDefinition: ({ name, definition }, client) =>
        this.#change(client, "mcp.updateDefinition", [{ kind: "mcpServer", id: name }], async (wrote) => {
          const stored = await mcp.read(name);
          if (!stored) throw new McpServerNotFound(name);
          if (!stored.value) throw new InvalidOwnedFile(stored.path, stored.problem ?? "invalid");
          const { adoptedFrom } = stored.value;
          wrote(await mcp.write(name, McpServerFile.parse({ ...definition, ...(adoptedFrom && { adoptedFrom }) })));
          await this.#rewritePersonal((server) => server === name, wrote);
        }),
    };
  }
}
