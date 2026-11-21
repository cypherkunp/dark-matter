// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${env:…}` and `${secret:…}` are MCP references, not templates.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { editConfigFile, jsonc } from "../src/config-edit";
import { memorySecrets } from "../src/index";
import { agentHome, gitRepo } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

/** Library MCP Servers written before the core starts: `mcp/<name>.json`. */
const seedMcp = async (libraryHome: string, servers: Record<string, unknown>) => {
  await mkdir(join(libraryHome, "mcp"), { recursive: true });
  for (const [name, definition] of Object.entries(servers))
    await writeFile(join(libraryHome, "mcp", `${name}.json`), `${JSON.stringify(definition, null, 2)}\n`);
};

const github = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:github.GITHUB_PERSONAL_ACCESS_TOKEN}", LOG: "info" },
};

const linear = {
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  headers: { Authorization: "Bearer ${secret:linear.Authorization}" },
};

/** `~/.claude.json` as Claude Code keeps it: a big state file with other Projects and keys. */
const claudeJson = (app: string) => `{
  "numStartups": 3,
  "mcpServers": {},
  "projects": {
    "/work/other": {
      "allowedTools": [],
      "mcpServers": {}
    },
    "${app}": {
      "allowedTools": [],
      "mcpServers": {}
    }
  },
  "tipsHistory": {
    "a": 1
  }
}
`;

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
  /** A git repo confirmed as a Project with these Agents. */
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

describe("Personal Project MCP Servers", () => {
  test("Claude Code: written into its local scope in ~/.claude.json with the real Secret, every other byte unchanged", async () => {
    const { libraryHome, trpc, project, fixture } = await setup();
    const app = await project("code/app", ["claude-code"]);
    const config = await fixture.file(".claude.json", claudeJson(app));

    const added = await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "github" }] });

    expect(await read(config)).toBe(
      claudeJson(app).replace(
        `"${app}": {
      "allowedTools": [],
      "mcpServers": {}`,
        `"${app}": {
      "allowedTools": [],
      "mcpServers": {
        "github": {
          "type": "stdio",
          "command": "npx",
          "args": [
            "-y",
            "@modelcontextprotocol/server-github"
          ],
          "env": {
            "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_real",
            "LOG": "info"
          }
        }
      }`,
      ),
    );
    expect((await readJson(join(libraryHome, "projects.json"))).projects[app].mcpServers).toEqual({
      github: {
        mode: "personal",
        on: true,
        delivered: [{ agent: "claude-code", file: "~/.claude.json", at: ["projects", app, "mcpServers", "github"] }],
      },
    });
    const view = {
      name: "github",
      mode: "personal",
      on: true,
      secrets: ["github.GITHUB_PERSONAL_ACCESS_TOKEN"],
      deliveries: [{ agent: "claude-code", file: "~/.claude.json", status: "delivered" }],
    };
    expect(added).toEqual([{ path: app, servers: [view] }]);
    expect(await trpc.project.mcpServers.query({ path: app })).toEqual([view]);
    // Nothing goes into git's exclude for a file outside the Project.
    expect(await read(join(app, ".git/info/exclude"))).not.toContain("Dark Matter");
    expect(git(app, "status", "--porcelain")).toBe("");
  });

  test("Cursor, OpenCode and Codex: their Project config files, kept out of git; the .agents Agent gets nothing", async () => {
    const { libraryHome, trpc, project } = await setup();
    const app = await project("code/app", ["cursor", "opencode", "codex", "agents"]);

    const [added] = await trpc.project.addMcpServers.mutate({
      servers: [
        { path: app, name: "github" },
        { path: app, name: "linear" },
      ],
    });

    expect(await readJson(join(app, ".cursor/mcp.json"))).toEqual({
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_real", LOG: "info" },
        },
        linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_real" } },
      },
    });
    expect(await readJson(join(app, "opencode.json"))).toEqual({
      mcp: {
        servers: {
          github: {
            type: "local",
            command: ["npx", "-y", "@modelcontextprotocol/server-github"],
            environment: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_real", LOG: "info" },
          },
          linear: { type: "remote", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_real" } },
        },
      },
    });
    expect(await read(join(app, ".codex/config.toml"))).toBe(`[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_real", LOG = "info" }

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
http_headers = { Authorization = "Bearer lin_real" }
`);
    expect(await read(join(app, ".git/info/exclude"))).toContain(
      "/.codex/config.toml\n/.cursor/mcp.json\n/opencode.json\n",
    );
    expect(git(app, "status", "--porcelain")).toBe("");
    // No `.agents` MCP surface: nothing under .agents, and no delivery row for it.
    expect(added?.servers.map((server) => server.deliveries.map((d) => d.agent))).toEqual([
      ["cursor", "opencode", "codex"],
      ["cursor", "opencode", "codex"],
    ]);
    expect((await readJson(join(libraryHome, "projects.json"))).projects[app].mcpServers.linear.delivered).toEqual([
      { agent: "cursor", file: "~/code/app/.cursor/mcp.json", at: ["mcpServers", "linear"] },
      { agent: "opencode", file: "~/code/app/opencode.json", at: ["mcp", "servers", "linear"] },
      { agent: "codex", file: "~/code/app/.codex/config.toml", at: ["mcp_servers", "linear"] },
    ]);
  });

  test("Personal isn't offered for an Agent whose Project config file is tracked by git; that file is never touched", async () => {
    const { trpc, project, fixture } = await setup();
    const app = await project("code/app", ["cursor", "codex"]);
    const committed = '{\n  "mcpServers": {}\n}\n';
    await fixture.file(join(app, ".cursor/mcp.json"), committed);
    git(app, "add", ".cursor/mcp.json");
    git(app, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "cursor");

    expect(await trpc.project.mcpTargets.query({ path: app })).toEqual([
      { agent: "cursor", file: "~/code/app/.cursor/mcp.json", personal: false },
      { agent: "codex", file: "~/code/app/.codex/config.toml", personal: true },
    ]);

    const [added] = await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "github" }] });

    expect(await read(join(app, ".cursor/mcp.json"))).toBe(committed);
    expect(await read(join(app, ".codex/config.toml"))).toContain("ghp_real");
    expect(added?.servers[0]?.deliveries).toEqual([
      { agent: "cursor", file: "~/code/app/.cursor/mcp.json", status: "tracked" },
      { agent: "codex", file: "~/code/app/.codex/config.toml", status: "delivered" },
    ]);
    expect(await read(join(app, ".git/info/exclude"))).not.toContain(".cursor/mcp.json");
    expect(git(app, "status", "--porcelain")).toBe("");
  });

  test("Off removes the delivered entries and remembers mode and Agents; On writes them back; Remove forgets it", async () => {
    const { libraryHome, trpc, project, fixture } = await setup();
    const app = await project("code/app", ["claude-code", "opencode", "codex"]);
    const claude = await fixture.file(".claude.json", claudeJson(app));
    const opencode = `{
  // my settings
  "theme": "system",
  "mcp": {
    "servers": {},
  },
}
`;
    await fixture.file(join(app, "opencode.json"), opencode);
    const recorded = async () => (await readJson(join(libraryHome, "projects.json"))).projects[app];
    await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "github" }] });

    const off = await trpc.project.setMcpServerOn.mutate({ path: app, name: "github", on: false });

    expect(await read(claude)).toBe(claudeJson(app));
    expect(await read(join(app, "opencode.json"))).toBe(opencode);
    // A Project file Dark Matter created and left empty goes, and so does its exclude line.
    await expect(read(join(app, ".codex/config.toml"))).rejects.toThrow(/ENOENT/);
    expect(await read(join(app, ".git/info/exclude"))).not.toContain("Dark Matter");
    expect(await recorded()).toEqual({
      agents: ["claude-code", "opencode", "codex"],
      skills: {},
      mcpServers: { github: { mode: "personal", on: false, delivered: [] } },
    });
    expect(off.servers[0]?.deliveries.map((d) => d.status)).toEqual(["off", "off", "off"]);

    await trpc.project.setMcpServerOn.mutate({ path: app, name: "github", on: true });

    expect(await read(claude)).toContain('"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_real"');
    expect(await read(join(app, "opencode.json"))).toContain("// my settings");
    expect(await read(join(app, "opencode.json"))).toContain('"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_real"');
    expect(await read(join(app, ".codex/config.toml"))).toContain("[mcp_servers.github]");

    const removed = await trpc.project.removeMcpServer.mutate({ path: app, name: "github" });

    expect(removed.servers).toEqual([]);
    expect(await read(claude)).toBe(claudeJson(app));
    expect(await read(join(app, "opencode.json"))).toBe(opencode);
    expect(await recorded()).toEqual({ agents: ["claude-code", "opencode", "codex"], skills: {} });
    expect((await trpc.activity.list.query({})).entries.map((entry) => entry.action).slice(0, 4)).toEqual([
      "project.removeMcpServer",
      "project.mcpServerOn",
      "project.mcpServerOff",
      "project.addMcpServers",
    ]);
  });

  test("a name already taken in a target file is a Name Conflict: nothing is written in any Project", async () => {
    const { libraryHome, trpc, project, fixture } = await setup();
    const app = await project("code/app", ["cursor"]);
    const web = await project("code/web", ["codex"]);
    const theirs = '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  }\n}\n';
    await fixture.file(join(web, ".codex/config.toml"), '[mcp_servers.github]\ncommand = "gh-mcp"\n');
    await fixture.file(join(app, ".cursor/mcp.json"), theirs);
    const before = await read(join(libraryHome, "projects.json"));

    await expect(
      trpc.project.addMcpServers.mutate({
        servers: [
          { path: web, name: "linear" },
          { path: app, name: "github" },
        ],
      }),
    ).rejects.toMatchObject({ data: { tag: "NameConflict" } });

    expect(await read(join(app, ".cursor/mcp.json"))).toBe(theirs);
    expect(await read(join(web, ".codex/config.toml"))).toBe('[mcp_servers.github]\ncommand = "gh-mcp"\n');
    expect(await read(join(libraryHome, "projects.json"))).toBe(before);
  });

  test("rotating a Secret or editing a definition rewrites Personal deliveries straight away", async () => {
    const { secrets, trpc, project, fixture } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    const web = await project("code/web", ["cursor"]);
    const claude = await fixture.file(".claude.json", claudeJson(app));
    await trpc.project.addMcpServers.mutate({
      servers: [
        { path: app, name: "github" },
        { path: web, name: "github" },
        { path: web, name: "linear" },
      ],
    });
    await trpc.project.setMcpServerOn.mutate({ path: web, name: "linear", on: false });

    await trpc.mcp.setSecret.mutate({ name: "github.GITHUB_PERSONAL_ACCESS_TOKEN", value: "ghp_rotated" });

    expect(secrets.values.get("github.GITHUB_PERSONAL_ACCESS_TOKEN")).toBe("ghp_rotated");
    expect(await read(claude)).toContain('"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_rotated"');
    expect(await read(join(app, ".codex/config.toml"))).toContain('GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_rotated"');
    expect((await readJson(join(web, ".cursor/mcp.json"))).mcpServers).toEqual({
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_rotated", LOG: "info" },
      },
    });
    const [rotated] = (await trpc.activity.list.query({})).entries;
    expect(rotated).toMatchObject({ action: "mcp.setSecret", subjects: [{ kind: "mcpServer", id: "github" }] });
    expect(JSON.stringify(rotated)).not.toContain("ghp_rotated");

    await trpc.mcp.updateDefinition.mutate({
      name: "github",
      definition: { ...github, transport: "stdio", args: ["-y", "@modelcontextprotocol/server-github@2"] },
    });

    expect(await read(claude)).toContain('"@modelcontextprotocol/server-github@2"');
    expect(await read(join(app, ".codex/config.toml"))).toContain(
      'args = ["-y", "@modelcontextprotocol/server-github@2"]',
    );
    expect((await readJson(join(web, ".cursor/mcp.json"))).mcpServers.github.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-github@2",
    ]);
    // Off stays off.
    expect((await readJson(join(web, ".cursor/mcp.json"))).mcpServers.linear).toBeUndefined();
  });

  test("changing a Project's Agents moves its MCP entries to the new Agents' files", async () => {
    const { trpc, project, fixture } = await setup();
    const app = await project("code/app", ["claude-code"]);
    const claude = await fixture.file(".claude.json", claudeJson(app));
    await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "linear" }] });

    await trpc.project.setAgents.mutate({ path: app, agents: ["cursor"] });

    expect(await read(claude)).toBe(claudeJson(app));
    expect((await readJson(join(app, ".cursor/mcp.json"))).mcpServers.linear.url).toBe("https://mcp.linear.app/mcp");
    expect((await trpc.project.mcpServers.query({ path: app }))[0]?.deliveries).toEqual([
      { agent: "cursor", file: "~/code/app/.cursor/mcp.json", status: "delivered" },
    ]);
  });

  test("env references are written in each Agent's syntax; Secrets as real values", async () => {
    const docs = {
      transport: "stdio",
      command: "docs-mcp",
      args: ["--root", "${env:DOCS_ROOT}"],
      env: { DOCS_TOKEN: "${env:DOCS_TOKEN}" },
    };
    const api = {
      transport: "http",
      url: "https://api.example.com/mcp",
      headers: { Authorization: "Bearer ${env:API_TOKEN}", "X-Team": "${env:TEAM}" },
    };
    const { trpc, project, fixture } = await setup({ docs, api });
    const app = await project("code/app", ["claude-code", "cursor", "opencode", "codex"]);
    const claude = await fixture.file(".claude.json", claudeJson(app));

    // Codex has no interpolation: an env reference inside an arg can't be written for it.
    await expect(trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "docs" }] })).rejects.toMatchObject({
      data: { tag: "McpNotTranslatable" },
    });
    await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "api" }] });
    const web = await project("code/web", ["claude-code", "opencode"]);
    await trpc.project.addMcpServers.mutate({ servers: [{ path: web, name: "docs" }] });

    expect((await readJson(claude)).projects[web].mcpServers.docs).toEqual({
      type: "stdio",
      command: "docs-mcp",
      args: ["--root", "${DOCS_ROOT}"],
      env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
    });
    expect((await readJson(join(web, "opencode.json"))).mcp.servers.docs).toEqual({
      type: "local",
      command: ["docs-mcp", "--root", "{env:DOCS_ROOT}"],
      environment: { DOCS_TOKEN: "{env:DOCS_TOKEN}" },
    });
    const local = (await readJson(claude)).projects[app].mcpServers;
    expect(local.api).toEqual({
      type: "http",
      url: "https://api.example.com/mcp",
      headers: { Authorization: "Bearer ${API_TOKEN}", "X-Team": "${TEAM}" },
    });
    expect((await readJson(join(app, ".cursor/mcp.json"))).mcpServers.api.headers).toEqual({
      Authorization: "Bearer ${env:API_TOKEN}",
      "X-Team": "${env:TEAM}",
    });
    expect((await readJson(join(app, "opencode.json"))).mcp.servers.api.headers).toEqual({
      Authorization: "Bearer {env:API_TOKEN}",
      "X-Team": "{env:TEAM}",
    });
    expect(await read(join(app, ".codex/config.toml"))).toBe(`[mcp_servers.api]
url = "https://api.example.com/mcp"
bearer_token_env_var = "API_TOKEN"
env_http_headers = { X-Team = "TEAM" }
`);
  });

  test("a Secret not in the keychain yet blocks delivery until it's entered", async () => {
    const { secrets, trpc, project } = await setup();
    secrets.values.delete("linear.Authorization");
    const app = await project("code/app", ["cursor"]);

    expect((await trpc.mcp.list.query()).servers.find((server) => server.name === "linear")?.missingSecrets).toEqual([
      "linear.Authorization",
    ]);
    await expect(trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "linear" }] })).rejects.toMatchObject(
      { data: { tag: "SecretMissing" } },
    );

    await trpc.mcp.setSecret.mutate({ name: "linear.Authorization", value: "lin_new" });
    await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "linear" }] });

    expect((await readJson(join(app, ".cursor/mcp.json"))).mcpServers.linear.headers).toEqual({
      Authorization: "Bearer lin_new",
    });
  });

  test("existing Codex TOML and OpenCode V1 files keep every other byte, and OpenCode V1 gets a V1 entry", async () => {
    const { trpc, project, fixture } = await setup();
    const app = await project("code/app", ["opencode", "codex"]);
    const codex = `# project config
model = "o3"

[mcp_servers.mine]
command = "mine" # mine
`;
    const opencode = `{
  "mcp": {
    "mine": { "type": "local", "command": ["mine"] }
  }
}
`;
    await fixture.file(join(app, ".codex/config.toml"), codex);
    await fixture.file(join(app, "opencode.json"), opencode);

    await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "linear" }] });

    expect(await read(join(app, ".codex/config.toml"))).toBe(`${codex}
[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
http_headers = { Authorization = "Bearer lin_real" }
`);
    expect((await readJson(join(app, "opencode.json"))).mcp).toEqual({
      mine: { type: "local", command: ["mine"] },
      linear: { type: "remote", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_real" } },
    });

    await trpc.project.removeMcpServer.mutate({ path: app, name: "linear" });

    expect(await read(join(app, ".codex/config.toml"))).toBe(codex);
    expect(await read(join(app, "opencode.json"))).toBe(opencode);
  });

  test("an OpenCode JSONC file keeps its comments, trailing commas and other entries byte for byte", async () => {
    const { trpc, project, fixture } = await setup();
    const app = await project("code/app", ["opencode"]);
    const before = `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      // mine
      "mine": { "type": "local", "command": ["mine"] }, // pinned
    },
  },
}
`;
    await fixture.file(join(app, "opencode.jsonc"), before);

    await trpc.project.addMcpServers.mutate({ servers: [{ path: app, name: "linear" }] });

    expect(await read(join(app, "opencode.jsonc"))).toBe(`{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      // mine
      "mine": { "type": "local", "command": ["mine"] }, // pinned
      "linear": {
        "type": "remote",
        "url": "https://mcp.linear.app/mcp",
        "headers": {
          "Authorization": "Bearer lin_real"
        }
      },
    },
  },
}
`);
    expect(await read(join(app, ".git/info/exclude"))).toContain("/opencode.jsonc\n");

    await trpc.project.setMcpServerOn.mutate({ path: app, name: "linear", on: false });

    expect(await read(join(app, "opencode.jsonc"))).toBe(before);
  });
});

describe("Editing ~/.claude.json while Claude Code runs", () => {
  test("a write by Claude Code between Dark Matter's read and its write isn't lost: the edit is re-applied", async () => {
    const { home } = await tempHome();
    const file = await agentHome(home).file(".claude.json", '{\n  "numStartups": 3\n}\n');
    let calls = 0;

    await editConfigFile(file, (text) => {
      calls++;
      // Claude Code rewrites the file while the edit is being made.
      if (calls === 1) writeFileSync(file, '{\n  "numStartups": 4\n}\n');
      return jsonc.put(text, ["projects", "/work/app", "mcpServers", "x"], { command: "x" });
    });

    expect(calls).toBe(2);
    expect(JSON.parse(await read(file))).toEqual({
      numStartups: 4,
      projects: { "/work/app": { mcpServers: { x: { command: "x" } } } },
    });
  });
});
