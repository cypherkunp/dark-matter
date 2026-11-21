// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${env:…}`, `${VAR}` and `${secret:…}` are MCP references, not templates.
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { memorySecrets } from "../src/index";
import { agentHome, gitRepo } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

const seedMcp = async (libraryHome: string, servers: Record<string, unknown>) => {
  await mkdir(join(libraryHome, "mcp"), { recursive: true });
  for (const [name, definition] of Object.entries(servers))
    await writeFile(join(libraryHome, "mcp", `${name}.json`), `${JSON.stringify(definition, null, 2)}\n`);
};

const github = {
  transport: "stdio" as const,
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:github.GITHUB_PERSONAL_ACCESS_TOKEN}", LOG: "info" },
};

const linear = {
  transport: "http" as const,
  url: "https://mcp.linear.app/mcp",
  headers: { Authorization: "Bearer ${secret:linear.Authorization}" },
};

const SECRET_VALUES = ["ghp_real", "lin_real"];

const setup = async (servers: Record<string, unknown> = { github, linear }) => {
  const { home, libraryHome } = await tempHome();
  await seedMcp(libraryHome, servers);
  const secrets = memorySecrets(
    new Map([
      ["github.GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_real"],
      ["linear.Authorization", "lin_real"],
    ]),
  );
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }, { secrets });
  const { trpc } = connect(core);
  const project = async (dir: string, agents: AgentId[]) => {
    const path = await gitRepo(home, dir);
    await trpc.project.add.mutate({ path, agents });
    return path;
  };
  return { home, libraryHome, secrets, trpc, project, fixture: agentHome(home) };
};

const read = (path: string) => readFile(path, "utf8");
const readJson = async (path: string) => JSON.parse(await read(path));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const commitAll = (cwd: string) => {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
};

/** Every file git would commit in the Project, with its text: what teammates get. */
const committable = async (project: string) => {
  const files = git(project, "ls-files", "--others", "--cached", "--exclude-standard").split("\n").filter(Boolean);
  return Promise.all(files.map(async (file) => ({ file, text: await read(join(project, file)) })));
};

const expectNoSecretIn = async (project: string) => {
  for (const { file, text } of await committable(project))
    for (const value of SECRET_VALUES) expect(text, `${file} holds a Secret value`).not.toContain(value);
};

describe("Shared Project MCP Servers", () => {
  test("Claude Code: .mcp.json with ${VAR} references only, my approval in .claude/settings.local.json, env vars listed", async () => {
    const { trpc, project } = await setup();
    const app = await project("code/app", ["claude-code"]);

    const [added] = await trpc.project.addMcpServers.mutate({
      servers: [
        { path: app, name: "github", mode: "shared" },
        { path: app, name: "linear", mode: "shared" },
      ],
    });

    expect(await read(join(app, ".mcp.json"))).toBe(`{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "\${GITHUB_PERSONAL_ACCESS_TOKEN}",
        "LOG": "info"
      }
    },
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": {
        "Authorization": "Bearer \${LINEAR_AUTHORIZATION}"
      }
    }
  }
}
`);
    expect(await readJson(join(app, ".claude/settings.local.json"))).toEqual({
      enabledMcpjsonServers: ["github", "linear"],
    });
    // .mcp.json is for the team; my approval stays out of git.
    const status = git(app, "status", "--porcelain");
    expect(status).toContain(".mcp.json");
    expect(status).not.toContain("settings.local.json");
    await expectNoSecretIn(app);
    expect(added?.servers).toEqual([
      {
        name: "github",
        mode: "shared",
        on: true,
        secrets: ["github.GITHUB_PERSONAL_ACCESS_TOKEN"],
        envVars: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
        deliveries: [{ agent: "claude-code", file: "~/code/app/.mcp.json", status: "delivered", approval: "approved" }],
      },
      {
        name: "linear",
        mode: "shared",
        on: true,
        secrets: ["linear.Authorization"],
        envVars: ["LINEAR_AUTHORIZATION"],
        deliveries: [{ agent: "claude-code", file: "~/code/app/.mcp.json", status: "delivered", approval: "approved" }],
      },
    ]);
  });

  test("Cursor, OpenCode and Codex: each Agent's env syntax in committed files; approval and trust states shown", async () => {
    const { home, trpc, project, fixture } = await setup();
    const app = await project("code/app", ["cursor", "opencode", "codex"]);
    const codexConfig = `model = "o4"

[projects."/elsewhere"]
trust_level = "trusted"
`;
    await fixture.file(".codex/config.toml", codexConfig);

    const [added] = await trpc.project.addMcpServers.mutate({
      servers: [
        { path: app, name: "github", mode: "shared" },
        { path: app, name: "linear", mode: "shared" },
      ],
    });

    expect(await readJson(join(app, ".cursor/mcp.json"))).toEqual({
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${env:GITHUB_PERSONAL_ACCESS_TOKEN}", LOG: "info" },
        },
        linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${env:LINEAR_AUTHORIZATION}" } },
      },
    });
    expect(await readJson(join(app, "opencode.json"))).toEqual({
      mcp: {
        servers: {
          github: {
            type: "local",
            command: ["npx", "-y", "@modelcontextprotocol/server-github"],
            environment: { GITHUB_PERSONAL_ACCESS_TOKEN: "{env:GITHUB_PERSONAL_ACCESS_TOKEN}", LOG: "info" },
          },
          linear: {
            type: "remote",
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: "Bearer {env:LINEAR_AUTHORIZATION}" },
          },
        },
      },
    });
    expect(await read(join(app, ".codex/config.toml"))).toBe(`[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { LOG = "info" }
env_vars = ["GITHUB_PERSONAL_ACCESS_TOKEN"]

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
bearer_token_env_var = "LINEAR_AUTHORIZATION"
`);
    // None of them is excluded: they're for the team.
    expect(await read(join(app, ".git/info/exclude"))).not.toMatch(/cursor|opencode|codex/);
    await expectNoSecretIn(app);
    expect(added?.servers.find((server) => server.name === "github")?.deliveries).toEqual([
      { agent: "cursor", file: "~/code/app/.cursor/mcp.json", status: "delivered", approval: "needsApproval" },
      { agent: "opencode", file: "~/code/app/opencode.json", status: "delivered" },
      { agent: "codex", file: "~/code/app/.codex/config.toml", status: "delivered", approval: "untrusted" },
    ]);
    // Dark Matter never trusts a Project in Codex by itself.
    expect(await read(join(home, ".codex/config.toml"))).toBe(codexConfig);

    const trusted = await trpc.project.trustInCodex.mutate({ path: app });
    expect(await read(join(home, ".codex/config.toml"))).toBe(`${codexConfig}
[projects."${app}"]
trust_level = "trusted"
`);
    expect(trusted.servers[0]?.deliveries.find((delivery) => delivery.agent === "codex")?.approval).toBeUndefined();
  });

  test("the dry run shows the edits, the env vars teammates must set and that it's a team change, writing nothing", async () => {
    const { trpc, project } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    const before = await readdir(app);

    const plan = await trpc.project.mcpPlan.query({ path: app, name: "linear", mode: "shared" });

    expect(plan).toEqual({
      edits: [
        { file: "~/code/app/.mcp.json", change: "write mcpServers.linear" },
        { file: "~/code/app/.codex/config.toml", change: "write mcp_servers.linear" },
        { file: "~/code/app/.claude/settings.local.json", change: "approve linear" },
      ],
      envVars: ["LINEAR_AUTHORIZATION"],
      teamChange: true,
    });
    expect(await readdir(app)).toEqual(before);
    expect((await trpc.project.mcpPlan.query({ path: app, name: "linear" })).teamChange).toBe(false);
  });

  test("Off removes the Shared entries and my approval (a team change); On writes them back", async () => {
    const { trpc, project } = await setup();
    const app = await project("code/app", ["claude-code"]);
    await writeFile(join(app, ".mcp.json"), `{\n  "mcpServers": {\n    "team": { "command": "team-server" }\n  }\n}\n`);
    commitAll(app);
    await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "github", mode: "shared" }] });
    // The teammate's entry keeps its bytes; ours is spliced in after it.
    const withOurs = await read(join(app, ".mcp.json"));
    expect(
      withOurs.startsWith(`{\n  "mcpServers": {\n    "team": { "command": "team-server" },\n    "github": {\n`),
    ).toBe(true);
    expect(withOurs.endsWith("    }\n  }\n}\n")).toBe(true);
    commitAll(app);

    const plan = await trpc.project.mcpPlan.query({ path: app, name: "github", on: false });
    expect(plan.teamChange).toBe(true);
    const off = await trpc.project.setMcpServerOn.mutate({ path: app, name: "github", on: false });

    expect(await read(join(app, ".mcp.json"))).toBe(
      `{\n  "mcpServers": {\n    "team": { "command": "team-server" }\n  }\n}\n`,
    );
    expect(await readJson(join(app, ".claude/settings.local.json"))).toEqual({ enabledMcpjsonServers: [] });
    expect(off.servers[0]?.deliveries).toEqual([{ agent: "claude-code", file: "~/code/app/.mcp.json", status: "off" }]);

    await trpc.project.setMcpServerOn.mutate({ path: app, name: "github", on: true });
    expect(Object.keys((await readJson(join(app, ".mcp.json"))).mcpServers)).toEqual(["team", "github"]);
  });

  test("editing a definition rewrites Personal at once and marks Shared outdated until that Project updates", async () => {
    const { trpc, project } = await setup();
    const shared = await project("code/shared", ["claude-code"]);
    const personal = await project("code/personal", ["cursor"]);
    await trpc.project.addMcpServers.mutate({
      servers: [
        { path: shared, name: "github", mode: "shared" },
        { path: personal, name: "github" },
      ],
    });
    commitAll(shared);
    const sharedBefore = await read(join(shared, ".mcp.json"));

    await trpc.mcp.updateDefinition.mutate({ name: "github", definition: { ...github, args: ["-y", "gh-mcp@2"] } });

    expect((await readJson(join(personal, ".cursor/mcp.json"))).mcpServers.github.args).toEqual(["-y", "gh-mcp@2"]);
    expect(await read(join(shared, ".mcp.json"))).toBe(sharedBefore);
    const [server] = await trpc.project.mcpServers.query({ path: shared });
    expect(server?.deliveries[0]?.status).toBe("outdated");

    // Rotating a Secret doesn't touch Shared files: they hold references only.
    await trpc.mcp.setSecret.mutate({ name: "github.GITHUB_PERSONAL_ACCESS_TOKEN", value: "ghp_rotated" });
    expect(await read(join(shared, ".mcp.json"))).toBe(sharedBefore);

    await trpc.project.updateMcpServer.mutate({ path: shared, name: "github" });
    expect((await readJson(join(shared, ".mcp.json"))).mcpServers.github.args).toEqual(["-y", "gh-mcp@2"]);
    expect((await trpc.project.mcpServers.query({ path: shared }))[0]?.deliveries[0]?.status).toBe("delivered");
  });

  test("a hand edit in the repo is modified in repo: never overwritten without asking; Take Library version or Pull into Library", async () => {
    const { libraryHome, trpc, project } = await setup();
    const app = await project("code/app", ["claude-code"]);
    const other = await project("code/other", ["claude-code"]);
    await trpc.project.addMcpServers.mutate({
      servers: [
        { path: app, name: "github", mode: "shared" },
        { path: other, name: "github", mode: "shared" },
      ],
    });
    const edited = (await read(join(app, ".mcp.json"))).replace('"LOG": "info"', '"LOG": "debug"');
    await writeFile(join(app, ".mcp.json"), edited);

    expect((await trpc.project.mcpServers.query({ path: app }))[0]?.deliveries[0]?.status).toBe("modifiedInRepo");
    // A definition change elsewhere leaves it alone.
    await trpc.mcp.updateDefinition.mutate({ name: "github", definition: { ...github, args: ["-y", "gh-mcp@2"] } });
    expect(await read(join(app, ".mcp.json"))).toBe(edited);
    await expect(trpc.project.updateMcpServer.mutate({ path: app, name: "github" })).rejects.toMatchObject({
      data: { tag: "McpModifiedInRepo" },
    });
    await expect(trpc.project.setMcpServerOn.mutate({ path: app, name: "github", on: false })).rejects.toMatchObject({
      data: { tag: "McpModifiedInRepo" },
    });
    expect(await read(join(app, ".mcp.json"))).toBe(edited);

    // Pull into Library: the edit becomes the definition, Secrets stay references; other Shared deliveries go outdated.
    await trpc.project.pullMcpServer.mutate({ path: app, name: "github", agent: "claude-code" });
    expect(await readJson(join(libraryHome, "mcp/github.json"))).toEqual({
      ...github,
      env: { ...github.env, LOG: "debug" },
    });
    expect((await trpc.project.mcpServers.query({ path: app }))[0]?.deliveries[0]?.status).toBe("delivered");
    expect((await trpc.project.mcpServers.query({ path: other }))[0]?.deliveries[0]?.status).toBe("outdated");

    // Take Library version, after confirming, discards a hand edit.
    await writeFile(join(other, ".mcp.json"), (await read(join(other, ".mcp.json"))).replace("npx", "bunx"));
    await trpc.project.updateMcpServer.mutate({ path: other, name: "github", discardEdits: true });
    expect((await readJson(join(other, ".mcp.json"))).mcpServers.github.env.LOG).toBe("debug");
    expect((await readJson(join(other, ".mcp.json"))).mcpServers.github.command).toBe("npx");
  });

  test("Personal and Shared can't share one config file: the excluded file would otherwise be committed", async () => {
    const { trpc, project } = await setup();
    const app = await project("code/app", ["cursor"]);
    await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "github" }] });

    await expect(
      trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "linear", mode: "shared" }] }),
    ).rejects.toMatchObject({ data: { tag: "McpFileShared" } });
  });

  test("switching Personal to Shared replaces real values with references and drops the exclude", async () => {
    const { trpc, project } = await setup();
    const app = await project("code/app", ["cursor"]);
    await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "github" }] });
    expect(await read(join(app, ".git/info/exclude"))).toContain(".cursor/mcp.json");

    await trpc.project.setMcpServerMode.mutate({ path: app, name: "github", mode: "shared" });

    expect((await readJson(join(app, ".cursor/mcp.json"))).mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(
      "${env:GITHUB_PERSONAL_ACCESS_TOKEN}",
    );
    expect(await read(join(app, ".git/info/exclude"))).not.toContain(".cursor/mcp.json");
    await expectNoSecretIn(app);
  });
});

describe("MCP entries already in a Project", () => {
  test("committed entries Dark Matter didn't write are Vendored; untracked and Claude local-scope ones Adopt back as Personal", async () => {
    const { home, libraryHome, secrets, trpc, project, fixture } = await setup({});
    const app = await project("code/app", ["claude-code", "cursor"]);
    await writeFile(join(app, ".mcp.json"), `{ "mcpServers": { "team": { "command": "team-server" } } }\n`);
    commitAll(app);
    await mkdir(join(app, ".cursor"));
    await writeFile(
      join(app, ".cursor/mcp.json"),
      `{ "mcpServers": { "notes": { "command": "notes", "env": { "NOTES_TOKEN": "tok_inline" } } } }\n`,
    );
    await fixture.file(
      ".claude.json",
      JSON.stringify({ projects: { [app]: { mcpServers: { local: { type: "stdio", command: "local-server" } } } } }),
    );

    const found = await trpc.project.repoMcpServers.query({ path: app });
    expect(found.vendored).toEqual([
      {
        id: `project-mcp:claude-code:${app}:team`,
        agent: "claude-code",
        name: "team",
        file: "~/code/app/.mcp.json",
        definition: { transport: "stdio", command: "team-server" },
      },
    ]);
    expect(found.untracked.map((entry) => entry.id)).toEqual([
      `project-mcp:claude-code:${app}:local`,
      `project-mcp:cursor:${app}:notes`,
    ]);
    expect(found.untracked[1]?.definition.env).toEqual({ NOTES_TOKEN: "${secret:notes.NOTES_TOKEN}" });

    const findings = found.untracked.map((entry) => entry.id);
    const plan = await trpc.mcp.adoptPlan.query({ findings });
    await trpc.mcp.adoptExecute.mutate({ findings, planId: plan.planId });

    expect(secrets.values.get("notes.NOTES_TOKEN")).toBe("tok_inline");
    expect(await readJson(join(libraryHome, "mcp/notes.json"))).toMatchObject({
      transport: "stdio",
      command: "notes",
      env: { NOTES_TOKEN: "${secret:notes.NOTES_TOKEN}" },
    });
    // Nothing changes for the Agents: the entries are back, now as Personal.
    expect((await readJson(join(app, ".cursor/mcp.json"))).mcpServers.notes).toEqual({
      command: "notes",
      env: { NOTES_TOKEN: "tok_inline" },
    });
    expect((await readJson(join(home, ".claude.json"))).projects[app].mcpServers.local).toEqual({
      type: "stdio",
      command: "local-server",
    });
    const servers = await trpc.project.mcpServers.query({ path: app });
    expect(servers.map((server) => [server.name, server.mode, server.on])).toEqual([
      ["local", "personal", true],
      ["notes", "personal", true],
    ]);
    expect((await trpc.project.repoMcpServers.query({ path: app })).untracked).toEqual([]);

    // Undo Adopt releases the Project MCP Server and puts the entry back as it was.
    await trpc.mcp.undoAdopt.mutate({ name: "notes" });
    expect((await readJson(join(app, ".cursor/mcp.json"))).mcpServers.notes).toEqual({
      command: "notes",
      env: { NOTES_TOKEN: "tok_inline" },
    });
    expect((await trpc.project.mcpServers.query({ path: app })).map((server) => server.name)).toEqual(["local"]);
  });
});

describe("Secrets", () => {
  test("deleting a Secret removes it from the keychain; refused while an On Personal delivery uses it", async () => {
    const { secrets, trpc, project } = await setup();
    const app = await project("code/app", ["cursor"]);
    await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "github" }] });

    await expect(trpc.mcp.deleteSecret.mutate({ name: "github.GITHUB_PERSONAL_ACCESS_TOKEN" })).rejects.toMatchObject({
      data: { tag: "SecretInUse" },
    });

    await trpc.mcp.deleteSecret.mutate({ name: "linear.Authorization" });
    expect(secrets.values.has("linear.Authorization")).toBe(false);
    const { servers } = await trpc.mcp.list.query();
    expect(servers.find((server) => server.name === "linear")?.missingSecrets).toEqual(["linear.Authorization"]);

    await trpc.project.setMcpServerOn.mutate({ path: app, name: "github", on: false });
    await trpc.mcp.deleteSecret.mutate({ name: "github.GITHUB_PERSONAL_ACCESS_TOKEN" });
    expect(secrets.values.has("github.GITHUB_PERSONAL_ACCESS_TOKEN")).toBe(false);
  });
});
