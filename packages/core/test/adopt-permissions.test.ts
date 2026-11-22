import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { agentHome, gitRepo } from "./agent-home";
import { bootCore, connect, connectAgent, tempHome } from "./harness";

const setup = async () => {
  const { home, libraryHome } = await tempHome();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  const { trpc } = connect(core);
  const fixture = agentHome(home);
  /** A git repo confirmed as a Project with these Agents. */
  const project = async (dir: string, agents: AgentId[]) => {
    const path = await gitRepo(home, dir);
    await trpc.project.add.mutate({ path, agents });
    return path;
  };
  return { home, libraryHome, core, trpc, fixture, project };
};

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const verdict = (finding: { owningAgent: string; adoptable: boolean; notAdoptableReason: string | null }) => ({
  owningAgent: finding.owningAgent,
  adoptable: finding.adoptable,
  notAdoptableReason: finding.notAdoptableReason,
});

const allOff = { skills: false, mcp: false };
const allOn = { skills: true, mcp: true };

describe("Adopt Permissions and the Agent Config Guard (ADR-0007)", () => {
  test("default to off for every Agent but .agents, with the Guard on", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });

    const { preferences } = await connect(core).trpc.settings.get.query();

    expect(preferences.adoptPermissions).toEqual({
      "claude-code": allOff,
      cursor: allOff,
      opencode: allOff,
      codex: allOff,
      agents: allOn,
    });
    expect(preferences.agentConfigGuard).toBe(true);
  });

  test("an existing settings.json from before them gets the safe defaults on upgrade", async () => {
    const { home, libraryHome } = await tempHome();
    await mkdir(libraryHome, { recursive: true });
    await writeFile(
      join(libraryHome, "settings.json"),
      JSON.stringify({ preferences: { scheduledScanTime: "07:30" }, ignoredFindings: [] }),
    );
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });

    const { preferences } = await connect(core).trpc.settings.get.query();

    expect(preferences.scheduledScanTime).toBe("07:30");
    expect(preferences.adoptPermissions["claude-code"]).toEqual(allOff);
    expect(preferences.adoptPermissions.agents).toEqual(allOn);
    expect(preferences.agentConfigGuard).toBe(true);
  });

  test("the app turns one Agent's permission or the Guard on and off; the rest stay as they were", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    const { trpc } = connect(core);

    await trpc.settings.setAdoptPermission.mutate({ agent: "claude-code", kind: "skills", allowed: true });
    const saved = await trpc.settings.setAgentConfigGuard.mutate({ on: false });

    expect(saved.preferences.adoptPermissions["claude-code"]).toEqual({ skills: true, mcp: false });
    expect(saved.preferences.adoptPermissions.cursor).toEqual(allOff);
    expect(saved.preferences.agentConfigGuard).toBe(false);
    expect((await trpc.settings.get.query()).preferences.agentConfigGuard).toBe(false);
  });

  test("only the app can change them", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    const agent = connectAgent(core);

    await expect(
      agent.trpc.settings.setAdoptPermission.mutate({ agent: "claude-code", kind: "skills", allowed: true }),
    ).rejects.toMatchObject({ data: { tag: "AppOnly" } });
    await expect(agent.trpc.settings.setAgentConfigGuard.mutate({ on: false })).rejects.toMatchObject({
      data: { tag: "AppOnly" },
    });
  });

  describe("Owning Agent", () => {
    test("a global skill folder belongs to one Agent by its path, however many Agents read it", async () => {
      const { trpc, fixture } = await setup();
      await fixture.skill(".claude/skills/pdf", { name: "pdf" });
      await fixture.skill(".agents/skills/csv", { name: "csv" });
      await fixture.skill(".cursor/skills/lint", { name: "lint" });

      const { globalSkills } = await trpc.scan.run.mutate();

      expect(Object.fromEntries(globalSkills.map((skill) => [skill.name, verdict(skill)]))).toEqual({
        pdf: { owningAgent: "claude-code", adoptable: false, notAdoptableReason: "adoptPermissionOff" },
        csv: { owningAgent: "agents", adoptable: true, notAdoptableReason: null },
        lint: { owningAgent: "cursor", adoptable: false, notAdoptableReason: "adoptPermissionOff" },
      });
    });

    test("a Skill linked into another Agent's folder belongs to the folder holding its real folder", async () => {
      const { trpc, fixture } = await setup();
      await fixture.skill(".claude/skills/pdf", { name: "pdf" });
      await fixture.link(".cursor/skills/pdf", ".claude/skills/pdf");

      const { globalSkills } = await trpc.scan.run.mutate();

      expect(globalSkills.map(verdict)).toEqual([
        { owningAgent: "claude-code", adoptable: false, notAdoptableReason: "adoptPermissionOff" },
      ]);
    });

    test("turning a permission on makes its Agent's findings adoptable without a new Scan", async () => {
      const { trpc, fixture } = await setup();
      await fixture.skill(".claude/skills/pdf", { name: "pdf" });
      await trpc.scan.run.mutate();

      await trpc.settings.setAdoptPermission.mutate({ agent: "claude-code", kind: "skills", allowed: true });

      const [group] = (await trpc.inbox.list.query()).globalSkills;
      expect(group?.findings.map(verdict)).toEqual([
        { owningAgent: "claude-code", adoptable: true, notAdoptableReason: null },
      ]);
    });

    test("a Project's own Agent folders belong to that Agent; its .agents/skills is always adoptable", async () => {
      const { trpc, fixture, project } = await setup();
      await trpc.settings.setAdoptPermission.mutate({ agent: "agents", kind: "skills", allowed: false });
      const app = await project("code/app", ["claude-code", "cursor"]);
      await fixture.skill(join(app, ".agents/skills/pdf"), { name: "pdf" });
      await fixture.skill(join(app, ".cursor/skills/lint"), { name: "lint" });
      await trpc.scan.run.mutate();

      const [group] = (await trpc.inbox.list.query()).untrackedSkills;

      expect(Object.fromEntries((group?.findings ?? []).map((skill) => [skill.name, verdict(skill)]))).toEqual({
        lint: { owningAgent: "cursor", adoptable: false, notAdoptableReason: "adoptPermissionOff" },
        pdf: { owningAgent: "agents", adoptable: true, notAdoptableReason: null },
      });
    });

    test("Agent-managed Skills belong to their Agent and are never adoptable", async () => {
      const { trpc, fixture } = await setup();
      await fixture.claudePlugin("figma", "official", "1.0.0", ["design"]);

      const { managedSkills } = await trpc.scan.run.mutate();

      expect(managedSkills.map(verdict)).toEqual([
        { owningAgent: "claude-code", adoptable: false, notAdoptableReason: "agentManaged" },
      ]);
    });
  });

  describe("Adopt of Skills", () => {
    test("is refused in the core when the Owning Agent doesn't allow it, and nothing moves", async () => {
      const { home, trpc, fixture } = await setup();
      await fixture.skill(".claude/skills/pdf", { name: "pdf" });
      await trpc.scan.run.mutate();
      const findings = ["global-skill:~/.claude/skills/pdf"];

      await expect(trpc.adopt.plan.query({ findings })).rejects.toMatchObject({
        data: { tag: "NotAdoptable" },
      });
      await expect(trpc.adopt.execute.mutate({ findings, planId: "any" })).rejects.toMatchObject({
        data: { tag: "NotAdoptable" },
      });
      expect(await exists(join(home, ".claude/skills/pdf"))).toBe(true);
    });

    test("goes ahead once the Owning Agent's Skills permission is on", async () => {
      const { home, libraryHome, trpc, fixture } = await setup();
      await fixture.skill(".claude/skills/pdf", { name: "pdf" });
      await trpc.settings.setAdoptPermission.mutate({ agent: "claude-code", kind: "skills", allowed: true });
      await trpc.scan.run.mutate();

      const plan = await trpc.adopt.plan.query({ findings: ["global-skill:~/.claude/skills/pdf"] });
      await trpc.adopt.execute.mutate({ findings: plan.findings, planId: plan.planId });

      expect(await exists(join(home, ".claude/skills/pdf"))).toBe(false);
      expect(await exists(join(libraryHome, "skills/local/pdf/SKILL.md"))).toBe(true);
    });

    test("an untracked Skill in a Project's own Agent folder follows that Agent's permission", async () => {
      const { trpc, fixture, project } = await setup();
      const app = await project("code/app", ["cursor"]);
      await fixture.skill(join(app, ".cursor/skills/lint"), { name: "lint" });
      await trpc.scan.run.mutate();

      await expect(
        trpc.adopt.plan.query({ findings: ["untracked-skill:~/code/app/.cursor/skills/lint"] }),
      ).rejects.toMatchObject({ data: { tag: "NotAdoptable" } });
    });

    test("Undo Adopt works after the permission is turned back off", async () => {
      const { home, trpc, fixture } = await setup();
      await fixture.skill(".claude/skills/pdf", { name: "pdf" });
      await trpc.settings.setAdoptPermission.mutate({ agent: "claude-code", kind: "skills", allowed: true });
      await trpc.scan.run.mutate();
      const plan = await trpc.adopt.plan.query({ findings: ["global-skill:~/.claude/skills/pdf"] });
      await trpc.adopt.execute.mutate({ findings: plan.findings, planId: plan.planId });
      await trpc.settings.setAdoptPermission.mutate({ agent: "claude-code", kind: "skills", allowed: false });

      await trpc.adopt.undo.mutate({ key: "local/pdf" });

      expect(await exists(join(home, ".claude/skills/pdf/SKILL.md"))).toBe(true);
    });
  });

  describe("Adopt of MCP Servers", () => {
    const claudeJson = `{ "mcpServers": { "github": { "type": "stdio", "command": "gh-mcp" } } }\n`;
    const findings = ["global-mcp:claude-code:github"];

    test("a Global MCP Server is refused while the Guard is on, even with its Agent's permission on", async () => {
      const { home, trpc, fixture } = await setup();
      await fixture.file(".claude.json", claudeJson);
      await trpc.settings.setAdoptPermission.mutate({ agent: "claude-code", kind: "mcp", allowed: true });
      const { globalMcpServers } = await trpc.scan.run.mutate();

      expect(globalMcpServers.map(verdict)).toEqual([
        { owningAgent: "claude-code", adoptable: false, notAdoptableReason: "agentConfigGuard" },
      ]);
      await expect(trpc.mcp.adoptPlan.query({ findings })).rejects.toMatchObject({
        data: { tag: "NotAdoptable" },
      });
      await expect(trpc.mcp.adoptExecute.mutate({ findings, planId: "any" })).rejects.toMatchObject({
        data: { tag: "NotAdoptable" },
      });
      expect(await readFile(join(home, ".claude.json"), "utf8")).toBe(claudeJson);
    });

    test("with the Guard off it still needs the Owning Agent's MCP permission", async () => {
      const { trpc, fixture } = await setup();
      await fixture.file(".claude.json", claudeJson);
      await trpc.settings.setAgentConfigGuard.mutate({ on: false });
      await trpc.scan.run.mutate();

      await expect(trpc.mcp.adoptPlan.query({ findings })).rejects.toMatchObject({
        data: { tag: "NotAdoptable" },
      });

      await trpc.settings.setAdoptPermission.mutate({ agent: "claude-code", kind: "mcp", allowed: true });
      const plan = await trpc.mcp.adoptPlan.query({ findings });
      await trpc.mcp.adoptExecute.mutate({ findings, planId: plan.planId });
      expect((await trpc.mcp.list.query()).servers.map((server) => server.name)).toEqual(["github"]);
    });

    test("Undo Adopt puts a Global MCP Server back even with the Guard on again", async () => {
      const { home, trpc, fixture } = await setup();
      await fixture.file(".claude.json", claudeJson);
      await trpc.settings.setAgentConfigGuard.mutate({ on: false });
      await trpc.settings.setAdoptPermission.mutate({ agent: "claude-code", kind: "mcp", allowed: true });
      await trpc.scan.run.mutate();
      const plan = await trpc.mcp.adoptPlan.query({ findings });
      await trpc.mcp.adoptExecute.mutate({ findings, planId: plan.planId });
      await trpc.settings.setAgentConfigGuard.mutate({ on: true });

      await trpc.mcp.undoAdopt.mutate({ name: "github" });

      expect(JSON.parse(await readFile(join(home, ".claude.json"), "utf8")).mcpServers).toHaveProperty("github");
    });

    test("an untracked Project MCP entry is refused while the Guard is on, then follows its Agent's MCP permission", async () => {
      const { trpc, project } = await setup();
      const app = await project("code/app", ["cursor"]);
      await mkdir(join(app, ".cursor"));
      await writeFile(join(app, ".cursor/mcp.json"), `{ "mcpServers": { "notes": { "command": "notes" } } }\n`);
      await trpc.settings.setAdoptPermission.mutate({ agent: "cursor", kind: "mcp", allowed: true });
      await trpc.scan.run.mutate();
      const ids = [`project-mcp:cursor:${app}:notes`];
      const inboxVerdicts = async () => (await trpc.inbox.list.query()).untrackedMcpServers[0]?.findings.map(verdict);

      expect(await inboxVerdicts()).toEqual([
        { owningAgent: "cursor", adoptable: false, notAdoptableReason: "agentConfigGuard" },
      ]);
      await expect(trpc.mcp.adoptPlan.query({ findings: ids })).rejects.toMatchObject({
        data: { tag: "NotAdoptable" },
      });

      await trpc.settings.setAgentConfigGuard.mutate({ on: false });
      await trpc.settings.setAdoptPermission.mutate({ agent: "cursor", kind: "mcp", allowed: false });
      expect(await inboxVerdicts()).toEqual([
        { owningAgent: "cursor", adoptable: false, notAdoptableReason: "adoptPermissionOff" },
      ]);
      await expect(trpc.mcp.adoptPlan.query({ findings: ids })).rejects.toMatchObject({
        data: { tag: "NotAdoptable" },
      });

      await trpc.settings.setAdoptPermission.mutate({ agent: "cursor", kind: "mcp", allowed: true });
      const plan = await trpc.mcp.adoptPlan.query({ findings: ids });
      await trpc.mcp.adoptExecute.mutate({ findings: ids, planId: plan.planId });
      expect((await trpc.mcp.list.query()).servers.map((server) => server.name)).toEqual(["notes"]);
    });

    test("the Project page lists untracked MCP entries with whether each can be adopted, from the current settings", async () => {
      const { trpc, project } = await setup();
      const app = await project("code/app", ["cursor"]);
      await mkdir(join(app, ".cursor"));
      await writeFile(join(app, ".cursor/mcp.json"), `{ "mcpServers": { "notes": { "command": "notes" } } }\n`);
      const verdicts = async () =>
        (await trpc.project.repoMcpServers.query({ path: app })).untracked.map((entry) => verdict(entry));

      expect(await verdicts()).toEqual([
        { owningAgent: "cursor", adoptable: false, notAdoptableReason: "agentConfigGuard" },
      ]);

      await trpc.settings.setAgentConfigGuard.mutate({ on: false });
      expect(await verdicts()).toEqual([
        { owningAgent: "cursor", adoptable: false, notAdoptableReason: "adoptPermissionOff" },
      ]);

      await trpc.settings.setAdoptPermission.mutate({ agent: "cursor", kind: "mcp", allowed: true });
      expect(await verdicts()).toEqual([{ owningAgent: "cursor", adoptable: true, notAdoptableReason: null }]);
    });
  });

  describe("Agent-managed off switches", () => {
    const settings = `{ "enabledPlugins": { "figma@official": true } }\n`;

    test("are refused while the Guard is on, and the Agent's settings stay untouched", async () => {
      const { home, trpc, fixture } = await setup();
      await fixture.claudePlugin("figma", "official", "1.0.0", ["design"]);
      await fixture.file(".claude/settings.json", settings);
      await fixture.file(".claude.json", `{ "oauthAccount": { "emailAddress": "me@example.com" } }\n`);
      const { managedSkills, managedMcpServers } = await trpc.scan.run.mutate();
      const connectors = managedMcpServers.find((server) => server.kind === "connector");

      await expect(
        trpc.managedSkills.turnOff.mutate({ id: managedSkills[0]?.id ?? "", scope: "plugin" }),
      ).rejects.toMatchObject({ data: { tag: "AgentConfigGuarded" } });
      await expect(
        trpc.managedMcp.turnOff.mutate({ id: connectors?.id ?? "", scope: "connectors" }),
      ).rejects.toMatchObject({ data: { tag: "AgentConfigGuarded" } });
      expect(await readFile(join(home, ".claude/settings.json"), "utf8")).toBe(settings);
    });

    test("work once the Guard is off", async () => {
      const { home, trpc, fixture } = await setup();
      await fixture.claudePlugin("figma", "official", "1.0.0", ["design"]);
      await fixture.file(".claude/settings.json", settings);
      await trpc.settings.setAgentConfigGuard.mutate({ on: false });
      const { managedSkills } = await trpc.scan.run.mutate();

      await trpc.managedSkills.turnOff.mutate({ id: managedSkills[0]?.id ?? "", scope: "plugin" });

      expect(JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8")).enabledPlugins).toEqual({
        "figma@official": false,
      });
    });
  });
});
