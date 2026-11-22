import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { InventoryGroup } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { agentHistory, agentHome, gitRepo } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });

const setup = async () => {
  const { home, libraryHome } = await tempHome();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  return { home, libraryHome, trpc: connect(core).trpc, fixture: agentHome(home) };
};

/** A group as the screens read it: its folder, owner, who sees it, and each item's verdict. */
const brief = (group: InventoryGroup) => ({
  label: group.label,
  owningAgent: group.owningAgent,
  agents: group.agents,
  items: group.items.map((item) => ({
    name: item.name,
    kind: item.kind,
    agents: item.agents,
    readOnlyReason: item.readOnlyReason,
  })),
});

describe("Inventory (#55)", () => {
  test("is empty before the first Scan", async () => {
    const { trpc } = await setup();

    expect(await trpc.agents.inventory.query()).toEqual({ groups: [] });
  });

  test("groups Global Skills by owning folder, .agents first, with the Agents that see each and why it's read-only", async () => {
    const { trpc, fixture } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf", description: "PDFs" });
    await fixture.skill(".agents/skills/csv", { name: "csv", description: "CSVs" });
    await fixture.skill(".cursor/skills/lint", { name: "lint", description: "Lint" });
    await trpc.scan.run.mutate();

    const { groups } = await trpc.agents.inventory.query();

    expect(groups.map(brief)).toEqual([
      {
        label: "~/.agents/skills",
        owningAgent: "agents",
        agents: ["cursor", "opencode", "codex", "agents"],
        items: [
          { name: "csv", kind: "globalSkill", agents: ["cursor", "opencode", "codex", "agents"], readOnlyReason: null },
        ],
      },
      {
        label: "~/.claude/skills",
        owningAgent: "claude-code",
        agents: ["claude-code", "cursor", "opencode"],
        items: [
          {
            name: "pdf",
            kind: "globalSkill",
            agents: ["claude-code", "cursor", "opencode"],
            readOnlyReason: "adoptPermissionOff",
          },
        ],
      },
      {
        label: "~/.cursor/skills",
        owningAgent: "cursor",
        agents: ["cursor"],
        items: [{ name: "lint", kind: "globalSkill", agents: ["cursor"], readOnlyReason: "adoptPermissionOff" }],
      },
    ]);
    expect(groups[0]?.items[0]).toMatchObject({ detail: "CSVs", adoptable: true, off: false });
  });

  test("lists Global MCP Servers under their Agent's config, read-only while the Agent Config Guard is on", async () => {
    const { trpc, fixture } = await setup();
    await fixture.file(
      ".claude.json",
      JSON.stringify({ mcpServers: { docs: { type: "stdio", command: "npx", args: ["docs-mcp"] } } }),
    );
    await fixture.file(
      ".cursor/mcp.json",
      JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app" } } }),
    );
    await trpc.scan.run.mutate();

    const { groups } = await trpc.agents.inventory.query();

    expect(groups.map(brief)).toEqual([
      {
        label: "~/.claude.json",
        owningAgent: "claude-code",
        agents: ["claude-code"],
        items: [{ name: "docs", kind: "globalMcpServer", agents: ["claude-code"], readOnlyReason: "agentConfigGuard" }],
      },
      {
        label: "~/.cursor/mcp.json",
        owningAgent: "cursor",
        agents: ["cursor"],
        items: [{ name: "linear", kind: "globalMcpServer", agents: ["cursor"], readOnlyReason: "agentConfigGuard" }],
      },
    ]);
    expect(groups[0]?.items[0]?.detail).toBe("npx docs-mcp");
    expect(groups[1]?.items[0]?.detail).toBe("https://mcp.linear.app");
  });

  test("lists Agent-managed Skills and MCP Servers under their Agent, read-only, off ones included", async () => {
    const { trpc, fixture } = await setup();
    await fixture.claudePlugin("figma", "claude-plugins-official", "2.2.211", ["figma-use"]);
    await fixture.file(
      ".claude/plugins/cache/claude-plugins-official/figma/2.2.211/.mcp.json",
      JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } } }),
    );
    await fixture.file(
      ".claude/settings.json",
      JSON.stringify({ enabledPlugins: { "figma@claude-plugins-official": false } }),
    );
    await trpc.scan.run.mutate();

    const { groups } = await trpc.agents.inventory.query();

    expect(groups.map(brief)).toEqual([
      {
        label: "~/.claude",
        owningAgent: "claude-code",
        agents: ["claude-code"],
        items: [
          { name: "figma-use", kind: "managedSkill", agents: ["claude-code"], readOnlyReason: "agentManaged" },
          {
            name: "plugin:figma:figma",
            kind: "managedMcpServer",
            agents: ["claude-code"],
            readOnlyReason: "agentManaged",
          },
        ],
      },
    ]);
    expect(groups[0]?.scope).toBe("managed");
    expect(groups[0]?.items.map((item) => item.off)).toEqual([true, true]);
  });

  test("lists untracked and Vendored Skills in confirmed and Suggested Projects, by Project folder", async () => {
    const { home, trpc, fixture } = await setup();
    const app = await gitRepo(home, "code/app");
    await fixture.skill(join(app, ".agents/skills/notes"), { name: "notes", description: "Notes" });
    await fixture.skill(join(app, ".claude/skills/local"), { name: "local", description: "Mine" });
    await fixture.skill(join(app, ".claude/skills/team"), { name: "team", description: "Team rules" });
    git(app, "add", ".claude/skills/team");
    git(app, "commit", "--quiet", "-m", "vendor team");
    await trpc.project.add.mutate({ path: app, agents: ["claude-code"] });
    // Not confirmed yet: a Suggested Project, from Claude Code's history.
    const web = await gitRepo(home, "code/web");
    await agentHistory(home).claudeJson([web]);
    await fixture.skill(join(web, ".cursor/skills/style"), { name: "style", description: "Style" });
    await fixture.skill(join(web, ".agents/skills/shared"), { name: "shared", description: "Shared" });
    git(web, "add", ".agents/skills/shared");
    git(web, "commit", "--quiet", "-m", "vendor shared");
    await trpc.scan.run.mutate();

    const { groups } = await trpc.agents.inventory.query();

    expect(groups.map(brief)).toEqual([
      {
        label: "app/.agents/skills",
        owningAgent: "agents",
        agents: ["cursor", "opencode", "codex", "agents"],
        items: [
          {
            name: "notes",
            kind: "untrackedSkill",
            agents: ["cursor", "opencode", "codex", "agents"],
            readOnlyReason: null,
          },
        ],
      },
      {
        label: "web/.agents/skills",
        owningAgent: "agents",
        agents: ["cursor", "opencode", "codex", "agents"],
        items: [
          {
            name: "shared",
            kind: "vendoredSkill",
            agents: ["cursor", "opencode", "codex", "agents"],
            readOnlyReason: "vendored",
          },
        ],
      },
      {
        label: "app/.claude/skills",
        owningAgent: "claude-code",
        agents: ["claude-code", "cursor", "opencode"],
        items: [
          {
            name: "local",
            kind: "untrackedSkill",
            agents: ["claude-code", "cursor", "opencode"],
            readOnlyReason: "adoptPermissionOff",
          },
          {
            name: "team",
            kind: "vendoredSkill",
            agents: ["claude-code", "cursor", "opencode"],
            readOnlyReason: "vendored",
          },
        ],
      },
      {
        label: "web/.cursor/skills",
        owningAgent: "cursor",
        agents: ["cursor"],
        items: [{ name: "style", kind: "untrackedSkill", agents: ["cursor"], readOnlyReason: "adoptPermissionOff" }],
      },
    ]);
    expect(groups.map((group) => group.project)).toEqual([app, web, app, web]);
  });
});
