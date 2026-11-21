// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${secret:…}` is an MCP reference, not a template.
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { memorySecrets } from "../src/index";
import { agentHome, gitRepo } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

const github = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:github.GITHUB_PERSONAL_ACCESS_TOKEN}" },
};
const linear = { transport: "http", url: "https://mcp.linear.app/mcp" };
const sentry = {
  transport: "http",
  url: "https://mcp.sentry.dev/mcp",
  headers: { Authorization: "Bearer ${secret:sentry.Authorization}" },
};

/** A Library with one Skill (`local/pdf`) and the given MCP Servers, written before the core starts. */
const setup = async (servers: Record<string, unknown> = { github, linear }) => {
  const { home, libraryHome } = await tempHome();
  await agentHome(libraryHome).skill(join(libraryHome, "skills/local/pdf"), { description: "PDFs" });
  await writeFile(
    join(libraryHome, "library-lock.json"),
    JSON.stringify({
      version: 1,
      skills: { "local/pdf": { source: "local/pdf", sourceType: "local", computedHash: "0".repeat(64) } },
    }),
  );
  await mkdir(join(libraryHome, "mcp"), { recursive: true });
  for (const [name, definition] of Object.entries(servers))
    await writeFile(join(libraryHome, "mcp", `${name}.json`), `${JSON.stringify(definition, null, 2)}\n`);
  const secrets = memorySecrets(new Map([["github.GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_real"]]));
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }, { secrets });
  const { trpc } = connect(core);
  const project = async (dir: string, agents: AgentId[] = ["cursor"]) => {
    const path = await gitRepo(home, dir);
    await trpc.project.add.mutate({ path, agents });
    return path;
  };
  const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  return { home, libraryHome, trpc, project, readJson, fixture: agentHome(home) };
};

const skill = (key: string) => ({ kind: "skill" as const, key });
const server = (name: string) => ({ kind: "mcpServer" as const, name });

describe("Collections with MCP Servers", () => {
  test("a Collection holds Library MCP Servers beside Skills; a deleted one shows as missing", async () => {
    const { libraryHome, trpc, readJson } = await setup();

    await trpc.collections.create.mutate({
      name: "kit",
      items: [skill("local/pdf"), server("github"), server("gone"), server("github")],
    });

    expect((await readJson(join(libraryHome, "settings.json"))).collections).toEqual({
      kit: { items: [skill("local/pdf"), server("github"), server("gone")] },
    });
    expect(await trpc.collections.list.query()).toEqual([
      {
        name: "kit",
        items: [
          { kind: "skill", key: "local/pdf", name: "pdf", missing: false },
          { kind: "mcpServer", name: "github", missing: false },
          { kind: "mcpServer", name: "gone", missing: true },
        ],
      },
    ]);
  });

  test("adding one to Projects creates Personal Project MCP Servers beside the Project Skills, in one Activity entry, and later edits don't touch them", async () => {
    const { libraryHome, trpc, project, readJson } = await setup();
    const app = await project("code/app");
    const api = await project("code/api");
    await trpc.collections.create.mutate({
      name: "kit",
      items: [skill("local/pdf"), server("github"), server("linear")],
    });

    const plan = await trpc.collections.plan.query({ name: "kit", projects: [app, api] });

    const cell = (path: string, name: string) => ({
      path,
      name,
      mode: "personal",
      outcome: "add",
      blockedBy: null,
      problem: null,
    });
    expect(plan.mcpCells).toEqual([cell(app, "github"), cell(app, "linear"), cell(api, "github"), cell(api, "linear")]);
    expect(plan.cells.map((c) => [c.path, c.key, c.outcome])).toEqual([
      [app, "local/pdf", "add"],
      [api, "local/pdf", "add"],
    ]);

    const applied = await trpc.collections.execute.mutate({
      name: "kit",
      skills: [{ path: app, key: "local/pdf" }],
      mcpServers: [
        { path: app, name: "github" },
        { path: app, name: "linear" },
        { path: api, name: "linear", mode: "personal" },
      ],
    });

    expect(applied.mcpCells).toEqual([cell(app, "github"), cell(app, "linear"), cell(api, "linear")]);
    expect(applied.mcpProjects.map((p) => [p.path, p.servers.map((s) => [s.name, s.mode, s.on])])).toEqual([
      [
        app,
        [
          ["github", "personal", true],
          ["linear", "personal", true],
        ],
      ],
      [api, [["linear", "personal", true]]],
    ]);
    expect(await readJson(join(app, ".cursor/mcp.json"))).toEqual({
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_real" },
        },
        linear: { url: "https://mcp.linear.app/mcp" },
      },
    });
    expect(await readlink(join(app, ".agents/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
    const [entry, ...more] = (await trpc.activity.list.query({ actions: ["collections.apply"] })).entries;
    expect(more).toEqual([]);
    expect(entry?.subjects).toEqual(
      expect.arrayContaining([
        { kind: "collection", id: "kit" },
        { kind: "project", id: api },
        { kind: "skill", id: "local/pdf" },
        { kind: "mcpServer", id: "linear" },
      ]),
    );

    const before = await readJson(join(libraryHome, "projects.json"));
    await trpc.collections.setItems.mutate({ name: "kit", items: [server("github")] });
    await trpc.collections.delete.mutate({ name: "kit" });
    expect(await readJson(join(libraryHome, "projects.json"))).toEqual(before);
    expect(await lstat(join(api, ".cursor/mcp.json")).then(() => true)).toBe(true);
  });

  test("Name Conflicts and other problems surface per item: blocked items are skipped while the rest are added", async () => {
    const { trpc, project, fixture, readJson } = await setup({ github, linear, sentry });
    const app = await project("code/app");
    await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "linear" }] });
    // An entry Dark Matter didn't write, under the name `github`.
    await fixture.file(
      join(app, ".cursor/mcp.json"),
      `${JSON.stringify({ mcpServers: { github: { url: "https://example.com" }, linear: { url: "https://mcp.linear.app/mcp" } } }, null, 2)}\n`,
    );
    await trpc.collections.create.mutate({
      name: "kit",
      items: [server("github"), server("linear"), server("sentry"), server("gone"), skill("local/pdf")],
    });

    const plan = await trpc.collections.plan.query({ name: "kit", projects: [app] });

    expect(
      plan.mcpCells.map(({ name, outcome, blockedBy, problem }) => ({ name, outcome, blockedBy, problem })),
    ).toEqual([
      {
        name: "github",
        outcome: "blocked",
        blockedBy: "~/code/app/.cursor/mcp.json › mcpServers.github",
        problem: "github can't be delivered: ~/code/app/.cursor/mcp.json › mcpServers.github is already taken",
      },
      { name: "linear", outcome: "present", blockedBy: null, problem: null },
      {
        name: "sentry",
        outcome: "blocked",
        blockedBy: null,
        problem: "The Secret sentry.Authorization isn't in the keychain yet",
      },
      { name: "gone", outcome: "missing", blockedBy: null, problem: null },
    ]);

    const applied = await trpc.collections.execute.mutate({
      name: "kit",
      skills: [{ path: app, key: "local/pdf" }],
      mcpServers: ["github", "sentry", "gone"].map((name) => ({ path: app, name })),
    });

    expect(applied.mcpCells.map((c) => [c.name, c.outcome])).toEqual([
      ["github", "blocked"],
      ["sentry", "blocked"],
      ["gone", "missing"],
    ]);
    expect(applied.cells.map((c) => [c.key, c.outcome])).toEqual([["local/pdf", "add"]]);
    expect(Object.keys((await readJson(join(app, ".cursor/mcp.json"))).mcpServers)).toEqual(["github", "linear"]);
    expect((await trpc.project.mcpServers.query({ path: app })).map((s) => s.name)).toEqual(["linear"]);
  });

  test("applying only MCP Servers works; an item outside the Collection is refused", async () => {
    const { trpc, project } = await setup();
    const app = await project("code/app");
    await trpc.collections.create.mutate({ name: "kit", items: [server("linear")] });

    await expect(
      trpc.collections.execute.mutate({ name: "kit", mcpServers: [{ path: app, name: "github" }] }),
    ).rejects.toMatchObject({ data: { tag: "CollectionItemNotFound" } });

    const applied = await trpc.collections.execute.mutate({ name: "kit", mcpServers: [{ path: app, name: "linear" }] });
    expect(applied.mcpCells.map((c) => c.outcome)).toEqual(["add"]);
    expect(applied.cells).toEqual([]);
  });
});
