// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${env:…}` and `${secret:…}` are MCP references, not templates.
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as toml } from "@decimalturn/toml-patch";
import { describe, expect, test } from "vitest";
import { memorySecrets } from "../src/index";
import { agentHome, snapshotTree } from "./agent-home";
import { allowAdoptEverywhere, bootCore, connect, tempHome } from "./harness";

/** Global MCP configs as each Agent writes them (research/mcp-config-per-agent.md). */
const claudeJson = `{
  "numStartups": 3,
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_claude"
      }
    },
    "docs": {
      "type": "http",
      "url": "\${DOCS_URL}/mcp"
    }
  },
  "projects": {
    "/work/app": { "allowedTools": [], "mcpServers": {} }
  },
  "tipsHistory": { "a": 1 }
}
`;

const cursorJson = `{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer lin_secret" }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_claude" }
    }
  }
}
`;

const opencodeJsonc = `{
  "$schema": "https://opencode.ai/config.json",
  // MCP servers I use everywhere
  "mcp": {
    "servers": {
      "playwright": {
        "type": "local",
        "command": ["npx", "@playwright/mcp"], // pinned later
        "environment": { "DEBUG": "{env:PW_DEBUG}" },
      },
    },
  },
  "theme": "system",
}
`;

const codexToml = `# Codex config
model = "o3" # default model

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env_vars = ["CONTEXT7_API_KEY"]

# GitHub, but with another token
[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]

[mcp_servers.github.env]
GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_codex"

[projects."/work/app"]
trust_level = "trusted"
`;

const setup = async () => {
  const { home, libraryHome } = await tempHome();
  const secrets = memorySecrets();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }, { secrets });
  const { trpc } = connect(core);
  await allowAdoptEverywhere(trpc);
  const fixture = agentHome(home);
  const configs = {
    claude: join(home, ".claude.json"),
    cursor: join(home, ".cursor/mcp.json"),
    opencode: join(home, ".config/opencode/opencode.jsonc"),
    codex: join(home, ".codex/config.toml"),
  };
  const writeAll = async () => {
    await fixture.file(configs.claude, claudeJson);
    await fixture.file(configs.cursor, cursorJson);
    await fixture.file(configs.opencode, opencodeJsonc);
    await fixture.file(configs.codex, codexToml);
  };
  /** Scans, then plans and applies Adopt for these findings. */
  const adopt = async (findings: string[], names?: Record<string, string>) => {
    await trpc.scan.run.mutate();
    const plan = await trpc.mcp.adoptPlan.query({ findings, ...(names && { names }) });
    await trpc.mcp.adoptExecute.mutate({ findings, ...(names && { names }), planId: plan.planId });
    return plan;
  };
  return { home, libraryHome, secrets, trpc, fixture, configs, writeAll, adopt };
};

const read = (path: string) => readFile(path, "utf8");
const readJson = async (path: string) => JSON.parse(await read(path));

describe("Scan: Global MCP Servers", () => {
  test("lists every Agent's global MCP Servers in the Inbox, with inline secrets masked", async () => {
    const { trpc, writeAll } = await setup();
    await writeAll();

    await trpc.scan.run.mutate();
    const inbox = await trpc.inbox.list.query();

    expect(inbox.count).toBe(7);
    expect(inbox.mcpServers.map((group) => [group.agent, group.file, group.findings.map((f) => f.name)])).toEqual([
      ["claude-code", "~/.claude.json", ["docs", "github"]],
      ["cursor", "~/.cursor/mcp.json", ["github", "linear"]],
      ["opencode", "~/.config/opencode/opencode.jsonc", ["playwright"]],
      ["codex", "~/.codex/config.toml", ["context7", "github"]],
    ]);
    const findings = inbox.mcpServers.flatMap((group) => group.findings);
    const byId = Object.fromEntries(findings.map((finding) => [finding.id, finding]));
    expect(byId["global-mcp:claude-code:github"]).toEqual({
      id: "global-mcp:claude-code:github",
      agent: "claude-code",
      name: "github",
      file: "~/.claude.json",
      definition: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:github.GITHUB_PERSONAL_ACCESS_TOKEN}" },
      },
      inlineSecrets: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      owningAgent: "claude-code",
      adoptable: true,
      notAdoptableReason: null,
    });
    expect(byId["global-mcp:claude-code:docs"]?.definition).toEqual({ transport: "http", url: "${env:DOCS_URL}/mcp" });
    expect(byId["global-mcp:cursor:linear"]?.definition).toEqual({
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer ${secret:linear.Authorization}" },
    });
    expect(byId["global-mcp:opencode:playwright"]?.definition).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["@playwright/mcp"],
      env: { DEBUG: "${env:PW_DEBUG}" },
    });
    expect(byId["global-mcp:codex:context7"]?.definition).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_API_KEY: "${env:CONTEXT7_API_KEY}" },
    });
    expect(byId["global-mcp:codex:context7"]?.inlineSecrets).toEqual([]);
    // Secret values never leave the core.
    expect(JSON.stringify(inbox)).not.toMatch(/ghp_|lin_secret/);
  });

  test("shows each Agent's MCP config path and Global MCP Server count on its card", async () => {
    const { trpc, writeAll } = await setup();
    await writeAll();
    await trpc.scan.run.mutate();

    const cards = await trpc.agents.list.query();

    expect(cards.map((card) => [card.id, card.mcpConfig, card.globalMcpServerCount])).toEqual([
      ["claude-code", "~/.claude.json", 2],
      ["cursor", "~/.cursor/mcp.json", 2],
      ["opencode", "~/.config/opencode/opencode.jsonc", 1],
      ["codex", "~/.codex/config.toml", 2],
      ["agents", null, null],
    ]);
  });

  test("OpenCode without a .jsonc falls back to opencode.json, and reads the V1 `mcp.<name>` shape", async () => {
    const { trpc, fixture, home } = await setup();
    await fixture.file(
      join(home, ".config/opencode/opencode.json"),
      JSON.stringify(
        { mcp: { sentry: { type: "remote", url: "https://mcp.sentry.dev/mcp", enabled: true } } },
        null,
        2,
      ),
    );
    await trpc.scan.run.mutate();

    const group = (await trpc.inbox.list.query()).mcpServers.find((g) => g.agent === "opencode");

    expect(group?.file).toBe("~/.config/opencode/opencode.json");
    expect(group?.findings.map((f) => [f.name, f.definition])).toEqual([
      ["sentry", { transport: "http", url: "https://mcp.sentry.dev/mcp" }],
    ]);
  });
});

describe("Adopt Global MCP Servers", () => {
  test("the plan is a dry run: nothing is written and no secret value is in it", async () => {
    const { trpc, writeAll, home, secrets } = await setup();
    await writeAll();
    await trpc.scan.run.mutate();
    const before = await snapshotTree(home, [".dark-matter"]);

    const plan = await trpc.mcp.adoptPlan.query({ findings: ["global-mcp:claude-code:github"] });

    expect(plan.servers).toEqual([
      {
        finding: "global-mcp:claude-code:github",
        agent: "claude-code",
        name: "github",
        libraryName: "github",
        outcome: "moved",
        secrets: ["github.GITHUB_PERSONAL_ACCESS_TOKEN"],
        diff: null,
      },
    ]);
    expect(plan.steps).toEqual([
      { kind: "storeSecret", name: "github.GITHUB_PERSONAL_ACCESS_TOKEN" },
      { kind: "editFile", path: "~/.dark-matter/mcp/github.json", change: "create" },
      { kind: "editFile", path: "~/.claude.json", change: "remove mcpServers.github" },
    ]);
    expect(JSON.stringify(plan)).not.toContain("ghp_");
    expect(await snapshotTree(home, [".dark-matter"])).toEqual(before);
    expect(secrets.values.size).toBe(0);
  });

  test("moves a Claude Code server into mcp/<name>.json, its token into the keychain, and removes only its entry from ~/.claude.json", async () => {
    const { trpc, writeAll, configs, libraryHome, secrets, adopt } = await setup();
    await writeAll();
    await chmod(configs.claude, 0o600);

    await adopt(["global-mcp:claude-code:github"]);

    expect(await read(configs.claude)).toBe(`{
  "numStartups": 3,
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "\${DOCS_URL}/mcp"
    }
  },
  "projects": {
    "/work/app": { "allowedTools": [], "mcpServers": {} }
  },
  "tipsHistory": { "a": 1 }
}
`);
    expect((await stat(configs.claude)).mode & 0o777).toBe(0o600);
    expect(await readJson(join(libraryHome, "mcp/github.json"))).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:github.GITHUB_PERSONAL_ACCESS_TOKEN}" },
      adoptedFrom: [
        {
          agent: "claude-code",
          file: "~/.claude.json",
          at: ["mcpServers", "github"],
          entry: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:github.GITHUB_PERSONAL_ACCESS_TOKEN}" },
          },
        },
      ],
    });
    expect(await read(join(libraryHome, "mcp/github.json"))).not.toContain("ghp_");
    expect(Object.fromEntries(secrets.values)).toEqual({ "github.GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_claude" });
    expect((await trpc.mcp.list.query()).servers).toEqual([
      {
        name: "github",
        definition: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:github.GITHUB_PERSONAL_ACCESS_TOKEN}" },
        },
        secrets: ["github.GITHUB_PERSONAL_ACCESS_TOKEN"],
        missingSecrets: [],
        adoptedFrom: [{ agent: "claude-code", file: "~/.claude.json" }],
        file: "~/.dark-matter/mcp/github.json",
        problem: null,
      },
    ]);
    const ids = (await trpc.inbox.list.query()).mcpServers.flatMap((group) => group.findings.map((f) => f.id));
    expect(ids).not.toContain("global-mcp:claude-code:github");
    const [entry] = (await trpc.activity.list.query({})).entries;
    expect(entry).toMatchObject({
      action: "mcp.adopt",
      result: "ok",
      subjects: [{ kind: "mcpServer", id: "github" }],
      filesWritten: ["~/.dark-matter/mcp/github.json", "~/.claude.json"],
    });
  });

  test("removes a Codex [mcp_servers.<name>] table with its sub-tables and comment, leaving every other byte", async () => {
    const { writeAll, configs, adopt } = await setup();
    await writeAll();

    await adopt(["global-mcp:codex:github"]);
    expect(await read(configs.codex)).toBe(`# Codex config
model = "o3" # default model

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env_vars = ["CONTEXT7_API_KEY"]

[projects."/work/app"]
trust_level = "trusted"
`);

    await adopt(["global-mcp:codex:context7"]);
    expect(await read(configs.codex)).toBe(`# Codex config
model = "o3" # default model

[projects."/work/app"]
trust_level = "trusted"
`);
  });

  test("keeps OpenCode's comments and trailing commas", async () => {
    const { writeAll, configs, libraryHome, adopt } = await setup();
    await writeAll();

    await adopt(["global-mcp:opencode:playwright"]);

    expect(await read(configs.opencode)).toBe(`{
  "$schema": "https://opencode.ai/config.json",
  // MCP servers I use everywhere
  "mcp": {
    "servers": {},
  },
  "theme": "system",
}
`);
    expect(await readJson(join(libraryHome, "mcp/playwright.json"))).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["@playwright/mcp"],
      env: { DEBUG: "${env:PW_DEBUG}" },
    });
  });

  test("a Bearer header keeps its scheme; only the token goes into the keychain", async () => {
    const { writeAll, libraryHome, secrets, adopt } = await setup();
    await writeAll();

    await adopt(["global-mcp:cursor:linear"]);

    expect(await readJson(join(libraryHome, "mcp/linear.json"))).toMatchObject({
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer ${secret:linear.Authorization}" },
    });
    expect(secrets.values.get("linear.Authorization")).toBe("lin_secret");
  });

  test("the same name with an identical definition becomes one Library MCP Server", async () => {
    const { writeAll, libraryHome, secrets, adopt, trpc, configs } = await setup();
    await writeAll();

    const plan = await adopt(["global-mcp:claude-code:github", "global-mcp:cursor:github"]);

    expect(plan.servers.map((server) => [server.finding, server.libraryName, server.outcome])).toEqual([
      ["global-mcp:claude-code:github", "github", "moved"],
      ["global-mcp:cursor:github", "github", "merged"],
    ]);
    expect(await readdir(join(libraryHome, "mcp"))).toEqual(["github.json"]);
    // The last entry goes with the comma before it, so strict JSON stays strict.
    expect(await read(configs.cursor)).toBe(`{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer lin_secret" }
    }
  }
}
`);
    expect(
      (await readJson(join(libraryHome, "mcp/github.json"))).adoptedFrom.map((a: { agent: string }) => a.agent),
    ).toEqual(["claude-code", "cursor"]);
    expect([...secrets.values.keys()]).toEqual(["github.GITHUB_PERSONAL_ACCESS_TOKEN"]);

    // Adopting later merges into it too.
    await trpc.mcp.undoAdopt.mutate({ name: "github" });
    await adopt(["global-mcp:claude-code:github"]);
    const later = await adopt(["global-mcp:cursor:github"]);
    expect(later.servers[0]).toMatchObject({ libraryName: "github", outcome: "merged", secrets: [] });
  });

  test("a different definition under the same name is a variant: suggested <name>-<agent>, or the name I choose", async () => {
    const { writeAll, libraryHome, secrets, adopt, trpc } = await setup();
    await writeAll();
    await adopt(["global-mcp:claude-code:github"]);

    const suggested = await trpc.mcp.adoptPlan.query({ findings: ["global-mcp:codex:github"] });
    expect(suggested.servers[0]).toMatchObject({ libraryName: "github-codex", outcome: "variant" });
    expect(suggested.servers[0]?.diff?.against).toBe("github");
    expect(suggested.servers[0]?.diff?.patch).toContain("github-codex.GITHUB_PERSONAL_ACCESS_TOKEN");

    await expect(
      trpc.mcp.adoptPlan.query({
        findings: ["global-mcp:codex:github"],
        names: { "global-mcp:codex:github": "github" },
      }),
    ).rejects.toMatchObject({ data: { tag: "NameConflict" } });

    const plan = await adopt(["global-mcp:codex:github"], { "global-mcp:codex:github": "github-work" });
    expect(plan.servers[0]).toMatchObject({ libraryName: "github-work", outcome: "variant" });
    expect((await readdir(join(libraryHome, "mcp"))).sort()).toEqual(["github-work.json", "github.json"]);
    expect(secrets.values.get("github-work.GITHUB_PERSONAL_ACCESS_TOKEN")).toBe("ghp_codex");
    expect(secrets.values.get("github.GITHUB_PERSONAL_ACCESS_TOKEN")).toBe("ghp_claude");
  });

  test("Undo Adopt restores every original entry with its secret, and removes the Library MCP Server", async () => {
    const { writeAll, configs, libraryHome, secrets, adopt, trpc } = await setup();
    await writeAll();
    await adopt(["global-mcp:claude-code:github", "global-mcp:cursor:github", "global-mcp:codex:github"]);
    expect(secrets.values.size).toBe(2);

    await trpc.mcp.undoAdopt.mutate({ name: "github" });
    await trpc.mcp.undoAdopt.mutate({ name: "github-codex" });

    expect(JSON.parse(await read(configs.claude))).toEqual(JSON.parse(claudeJson));
    expect(JSON.parse(await read(configs.cursor))).toEqual(JSON.parse(cursorJson));
    expect(toml(await read(configs.codex))).toEqual(toml(codexToml));
    // Everything outside the restored entry is still byte for byte the same.
    expect(await read(configs.claude)).toContain(`"tipsHistory": { "a": 1 }`);
    expect(await readdir(join(libraryHome, "mcp"))).toEqual([]);
    expect(secrets.values.size).toBe(0);
    await trpc.scan.run.mutate();
    expect((await trpc.inbox.list.query()).count).toBe(7);
  });

  test("Undo Adopt refuses when the name has been taken again in the Agent's config", async () => {
    const { writeAll, configs, adopt, trpc, libraryHome } = await setup();
    await writeAll();
    await adopt(["global-mcp:cursor:linear"]);
    await writeFile(configs.cursor, cursorJson);

    await expect(trpc.mcp.undoAdopt.mutate({ name: "linear" })).rejects.toMatchObject({
      data: { tag: "NameConflict" },
    });
    expect(await readdir(join(libraryHome, "mcp"))).toEqual(["linear.json"]);
  });

  test("a config changed since the plan is refused as stale, and nothing is written", async () => {
    const { writeAll, configs, trpc, libraryHome, secrets } = await setup();
    await writeAll();
    await trpc.scan.run.mutate();
    const plan = await trpc.mcp.adoptPlan.query({ findings: ["global-mcp:claude-code:github"] });
    const changed = claudeJson.replace("ghp_claude", "ghp_rotated");
    await writeFile(configs.claude, changed);

    await expect(trpc.mcp.adoptExecute.mutate({ findings: plan.findings, planId: plan.planId })).rejects.toMatchObject({
      data: { tag: "PlanStale" },
    });
    expect(await read(configs.claude)).toBe(changed);
    expect(await readdir(join(libraryHome, "mcp")).catch(() => [])).toEqual([]);
    expect(secrets.values.size).toBe(0);
  });
});
