// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${env:…}` are MCP references, not templates.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentHome, snapshotTree } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

const setup = async () => {
  const { home, libraryHome } = await tempHome();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  return { home, fixture: { home, ...agentHome(home) }, trpc: connect(core).trpc };
};

describe("Agent-managed MCP Servers", () => {
  test("Claude Code plugin servers are listed in the Inbox and counted on the Agent card", async () => {
    const { fixture, trpc } = await setup();
    await fixture.claudePlugin("figma", "claude-plugins-official", "2.2.211", []);
    await fixture.file(
      ".claude/plugins/cache/claude-plugins-official/figma/2.2.211/.mcp.json",
      JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } } }, null, 2),
    );
    // A plugin may also declare servers inline in its manifest, as a flat map.
    await fixture.claudePlugin("github", "claude-plugins-official", "1.0.0", []);
    await fixture.file(
      ".claude/plugins/cache/claude-plugins-official/github/1.0.0/.claude-plugin/plugin.json",
      JSON.stringify({
        name: "github",
        mcpServers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
          },
        },
      }),
    );

    await trpc.scan.run.mutate();

    const inbox = await trpc.inbox.list.query();
    expect(inbox.count).toBe(2);
    expect(inbox.managedMcpServers).toEqual([
      {
        agent: "claude-code",
        findings: [
          expect.objectContaining({
            id: "managed-mcp:claude-code:plugin:figma:figma",
            agent: "claude-code",
            name: "plugin:figma:figma",
            kind: "plugin",
            plugin: "figma@claude-plugins-official",
            source: "~/.claude/plugins/cache/claude-plugins-official/figma/2.2.211/.mcp.json",
            definition: { transport: "http", url: "https://mcp.figma.com/mcp" },
            off: false,
          }),
          expect.objectContaining({
            name: "plugin:github:github",
            definition: {
              transport: "http",
              url: "https://api.githubcopilot.com/mcp/",
              headers: { Authorization: "Bearer ${env:GITHUB_TOKEN}" },
            },
          }),
        ],
      },
    ]);
    const cards = await trpc.agents.list.query();
    expect(cards.map(({ id, managedMcpServerCount }) => ({ id, managedMcpServerCount }))).toEqual([
      { id: "claude-code", managedMcpServerCount: 2 },
      { id: "cursor", managedMcpServerCount: 0 },
      { id: "opencode", managedMcpServerCount: 0 },
      { id: "codex", managedMcpServerCount: 0 },
      { id: "agents", managedMcpServerCount: null },
    ]);
  });

  test("Turn off everywhere for a Claude Code plugin server sets enabledPlugins, keeping the file's layout", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.claudePlugin("figma", "claude-plugins-official", "2.2.211", []);
    await fixture.file(
      ".claude/plugins/cache/claude-plugins-official/figma/2.2.211/.mcp.json",
      JSON.stringify({ figma: { type: "http", url: "https://mcp.figma.com/mcp" } }),
    );
    await fixture.file(
      ".claude/settings.json",
      `{
  // theme first
  "theme": "dark",
  "enabledPlugins": {
    "other@market": true
  }
}
`,
    );
    await trpc.scan.run.mutate();
    const [server] = (await trpc.inbox.list.query()).managedMcpServers[0]?.findings ?? [];
    expect(server?.offSwitches).toEqual([
      {
        scope: "plugin",
        file: "~/.claude/settings.json",
        setting: '"enabledPlugins": { "figma@claude-plugins-official": false }',
      },
    ]);
    expect(server?.readOnly).toBeNull();

    await trpc.managedMcp.turnOff.mutate({ id: server?.id ?? "", scope: "plugin" });

    expect(await readFile(join(home, ".claude/settings.json"), "utf8")).toBe(`{
  // theme first
  "theme": "dark",
  "enabledPlugins": {
    "other@market": true,
    "figma@claude-plugins-official": false
  }
}
`);
    const inbox = await trpc.inbox.list.query();
    expect(inbox.count).toBe(0);
    expect(inbox.managedMcpServers).toEqual([]);
    expect((await trpc.activity.list.query()).entries[0]).toMatchObject({
      action: "managedMcp.turnOff",
      result: "ok",
      subjects: [{ kind: "finding", id: server?.id }],
      filesWritten: ["~/.claude/settings.json"],
    });
  });
  test("claude.ai connectors are turned off with disableClaudeAiConnectors; built-ins stay read-only", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.file(
      ".claude.json",
      `{
  "numStartups": 4,
  "oauthAccount": { "emailAddress": "me@example.com" },
  "claudeInChromeDefaultEnabled": true
}
`,
    );
    await fixture.file(".claude/settings.json", '{\n  "model": "opus"\n}\n');
    const before = await readFile(join(home, ".claude.json"), "utf8");

    await trpc.scan.run.mutate();
    const findings = (await trpc.inbox.list.query()).managedMcpServers[0]?.findings ?? [];
    expect(findings).toEqual([
      expect.objectContaining({
        id: "managed-mcp:claude-code:claude-in-chrome",
        kind: "builtin",
        source: null,
        definition: null,
        off: false,
        offSwitches: [],
        readOnly: expect.stringContaining("/chrome"),
      }),
      expect.objectContaining({
        id: "managed-mcp:claude-code:claude.ai connectors",
        kind: "connector",
        offSwitches: [
          { scope: "connectors", file: "~/.claude/settings.json", setting: '"disableClaudeAiConnectors": true' },
        ],
        readOnly: null,
      }),
    ]);
    await expect(
      trpc.managedMcp.turnOff.mutate({ id: "managed-mcp:claude-code:claude-in-chrome", scope: "server" }),
    ).rejects.toMatchObject({ data: { tag: "UnknownFinding" } });

    await trpc.managedMcp.turnOff.mutate({ id: "managed-mcp:claude-code:claude.ai connectors", scope: "connectors" });

    expect(await readFile(join(home, ".claude/settings.json"), "utf8")).toBe(
      '{\n  "model": "opus",\n  "disableClaudeAiConnectors": true\n}\n',
    );
    // Claude Code's hot state file is never written.
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe(before);
    const after = (await trpc.inbox.list.query()).managedMcpServers[0]?.findings ?? [];
    expect(after.map((server) => server.name)).toEqual(["claude-in-chrome"]);
  });

  test("Cursor's marketplace, team and local plugin servers are read-only and nothing is written", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.file(
      ".cursor/plugins/cache/cursor-public/context7/33414e/.cursor-plugin/plugin.json",
      JSON.stringify({ name: "context7", mcpServers: "./mcp.json" }),
    );
    await fixture.file(
      ".cursor/plugins/cache/cursor-public/context7/33414e/mcp.json",
      JSON.stringify({ mcpServers: { context7: { type: "http", url: "https://mcp.context7.com/mcp/oauth" } } }),
    );
    await fixture.file(
      ".cursor/plugins/cache/acme-team/deploy/9f1e/.mcp.json",
      JSON.stringify({
        mcpServers: { deploy: { command: "npx", args: ["-y", "@acme/deploy-mcp"], env: { TOKEN: "s3cr3t-value" } } },
      }),
    );
    await fixture.file(
      ".cursor/plugins/local/notes/mcp.json",
      JSON.stringify({ notes: { url: "http://localhost:4000/mcp" } }),
    );

    await trpc.scan.run.mutate();
    const findings = (await trpc.inbox.list.query()).managedMcpServers[0]?.findings ?? [];
    expect(findings.map(({ name, kind, plugin, offSwitches }) => ({ name, kind, plugin, offSwitches }))).toEqual([
      { name: "plugin-context7-context7", kind: "marketplace", plugin: "context7", offSwitches: [] },
      { name: "plugin-deploy-deploy", kind: "team", plugin: "deploy", offSwitches: [] },
      { name: "plugin-notes-notes", kind: "plugin", plugin: "notes", offSwitches: [] },
    ]);
    expect(findings[0]?.readOnly).toContain("Cursor Settings");
    // Inline secrets never leave the core.
    expect(JSON.stringify(findings)).not.toContain("s3cr3t-value");
    const card = (await trpc.agents.list.query()).find((agent) => agent.id === "cursor");
    expect(card).toMatchObject({ managedMcpServerCount: 3, managedMcpNotes: [expect.stringContaining("Team")] });

    const before = await snapshotTree(home, [".dark-matter"]);
    for (const finding of findings) {
      await expect(trpc.managedMcp.turnOff.mutate({ id: finding.id, scope: "server" })).rejects.toMatchObject({
        data: { tag: "UnknownFinding" },
      });
    }
    expect(await snapshotTree(home, [".dark-matter"])).toEqual(before);
  });

  const codexUser = `# my Codex settings
model = "gpt-5.5" # pinned

[mcp_servers.mine]
command = "my-mcp"
`;

  test("Codex: a system-layer server is turned off in the user config; managed and MDM servers are read-only", async () => {
    const { fixture, trpc, home } = await setup();
    const system = join(home, "../system");
    await fixture.file(
      join(system, "etc/codex/config.toml"),
      '[mcp_servers.docs]\nurl = "https://docs.example.com/mcp"\n',
    );
    await fixture.file(
      join(system, "etc/codex/managed_config.toml"),
      '[mcp_servers.audit]\ncommand = "audit-mcp"\nargs = ["--strict"]\n',
    );
    const mdmToml = Buffer.from('[mcp_servers.sso]\nurl = "https://sso.corp/mcp"\n').toString("base64");
    await fixture.file(
      join(system, "Library/Managed Preferences/com.openai.codex.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>config_toml_base64</key>
  <string>${mdmToml}</string>
</dict>
</plist>
`,
    );
    await fixture.file(".codex/config.toml", codexUser);

    await trpc.scan.run.mutate();
    const findings = (await trpc.inbox.list.query()).managedMcpServers.find(
      (group) => group.agent === "codex",
    )?.findings;
    expect(findings?.map(({ name, kind, offSwitches, readOnly }) => ({ name, kind, offSwitches, readOnly }))).toEqual([
      { name: "audit", kind: "managed", offSwitches: [], readOnly: expect.stringContaining("administrator") },
      {
        name: "docs",
        kind: "system",
        offSwitches: [{ scope: "server", file: "~/.codex/config.toml", setting: "[mcp_servers.docs] enabled = false" }],
        readOnly: null,
      },
      { name: "sso", kind: "managed", offSwitches: [], readOnly: expect.stringContaining("administrator") },
    ]);

    await trpc.managedMcp.turnOff.mutate({ id: "managed-mcp:codex:docs", scope: "server" });

    expect(await readFile(join(home, ".codex/config.toml"), "utf8")).toBe(`${codexUser}
[mcp_servers.docs]
enabled = false
`);
    const after = (await trpc.inbox.list.query()).managedMcpServers.find((group) => group.agent === "codex")?.findings;
    expect(after?.map((server) => server.name)).toEqual(["audit", "sso"]);
  });

  test("OpenCode plugins that add MCP Servers are listed read-only", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.file(
      ".config/opencode/plugins/linear.ts",
      'export default async () => ({ "mcp.transform": (editor) => editor.set("linear", { type: "remote", url: "https://mcp.linear.app/mcp" }) });\n',
    );
    await fixture.file(
      ".config/opencode/plugins/notify.ts",
      "export default async () => ({ event: async () => {} });\n",
    );
    await fixture.file(
      ".config/opencode/opencode.jsonc",
      '{\n  // plugins\n  "plugins": ["opencode-sentry@1.2.0"]\n}\n',
    );
    await fixture.file(
      ".config/opencode/node_modules/opencode-sentry/package.json",
      JSON.stringify({ name: "opencode-sentry", main: "dist/index.js" }),
    );
    await fixture.file(
      ".config/opencode/node_modules/opencode-sentry/dist/index.js",
      "export default () => ({ config: (c) => { c.mcp ??= {}; } });\n",
    );
    const before = await snapshotTree(home, [".dark-matter"]);

    await trpc.scan.run.mutate();
    const findings = (await trpc.inbox.list.query()).managedMcpServers.find(
      (group) => group.agent === "opencode",
    )?.findings;
    expect(findings?.map(({ name, kind, source, offSwitches }) => ({ name, kind, source, offSwitches }))).toEqual([
      { name: "linear", kind: "plugin", source: "~/.config/opencode/plugins/linear.ts", offSwitches: [] },
      {
        name: "opencode-sentry",
        kind: "plugin",
        source: "~/.config/opencode/node_modules/opencode-sentry/package.json",
        offSwitches: [],
      },
    ]);
    expect(findings?.[0]?.readOnly).toContain("OpenCode");
    expect(await snapshotTree(home, [".dark-matter"])).toEqual(before);
  });

  test("an ignored Agent-managed MCP Server leaves the Inbox count", async () => {
    const { fixture, trpc } = await setup();
    await fixture.file(".claude.json", '{ "oauthAccount": {} }\n');
    await trpc.scan.run.mutate();
    expect((await trpc.inbox.list.query()).count).toBe(1);

    await trpc.inbox.ignore.mutate({ id: "managed-mcp:claude-code:claude.ai connectors" });

    const inbox = await trpc.inbox.list.query();
    expect(inbox).toMatchObject({ count: 0, ignoredCount: 1, managedMcpServers: [] });
  });
});
