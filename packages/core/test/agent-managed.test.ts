import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentHome, snapshotTree } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

const setup = async () => {
  const { home, libraryHome } = await tempHome();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  return { home, libraryHome, fixture: { home, ...agentHome(home) }, trpc: connect(core).trpc };
};

describe("Agent-managed Skills", () => {
  test("a Scan lists Claude Code plugin Skills in the Inbox and counts them on the Agent card", async () => {
    const { fixture, trpc } = await setup();
    await fixture.claudePlugin("figma", "claude-plugins-official", "2.2.211", ["figma-use", "figma-code"]);
    // An older version left in the cache isn't the installed one.
    await fixture.skill(".claude/plugins/cache/claude-plugins-official/figma/2.2.157/skills/figma-use", {
      name: "figma-use",
    });

    await trpc.scan.run.mutate();

    const inbox = await trpc.inbox.list.query();
    expect(inbox.count).toBe(2);
    expect(inbox.managedSkills).toEqual([
      {
        agent: "claude-code",
        findings: [
          expect.objectContaining({
            id: "managed-skill:claude-code:~/.claude/plugins/cache/claude-plugins-official/figma/2.2.211/skills/figma-code",
            name: "figma-code",
            description: "figma-code from figma",
            agent: "claude-code",
            kind: "plugin",
            plugin: "figma@claude-plugins-official",
            off: false,
          }),
          expect.objectContaining({ name: "figma-use", plugin: "figma@claude-plugins-official" }),
        ],
      },
    ]);
    const cards = await trpc.agents.list.query();
    expect(cards.map(({ id, managedSkillCount }) => ({ id, managedSkillCount }))).toEqual([
      { id: "claude-code", managedSkillCount: 2 },
      { id: "cursor", managedSkillCount: 0 },
      { id: "opencode", managedSkillCount: 0 },
      { id: "codex", managedSkillCount: 0 },
      { id: "agents", managedSkillCount: 0 },
    ]);
  });

  test("Turn off everywhere for a Claude Code plugin Skill sets enabledPlugins in settings.json, keeping its layout", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.claudePlugin("figma", "claude-plugins-official", "2.2.211", ["figma-use"]);
    const settings = `{
    "model": "opus",
    "enabledPlugins": {
        "other@market": true
    },
    "permissions": { "allow": ["Bash(ls:*)"] }
}
`;
    await fixture.file(".claude/settings.json", settings);
    await trpc.scan.run.mutate();
    const [skill] = (await trpc.inbox.list.query()).managedSkills[0]?.findings ?? [];
    expect(skill?.offSwitches).toEqual([
      {
        scope: "plugin",
        file: "~/.claude/settings.json",
        setting: '"enabledPlugins": { "figma@claude-plugins-official": false }',
      },
    ]);

    await trpc.managedSkills.turnOff.mutate({ id: skill?.id ?? "", scope: "plugin" });

    expect(await readFile(join(home, ".claude/settings.json"), "utf8")).toBe(`{
    "model": "opus",
    "enabledPlugins": {
        "other@market": true,
        "figma@claude-plugins-official": false
    },
    "permissions": { "allow": ["Bash(ls:*)"] }
}
`);
    const inbox = await trpc.inbox.list.query();
    expect(inbox.count).toBe(0);
    expect(inbox.managedSkills).toEqual([]);
    expect((await trpc.agents.list.query())[0]?.managedSkillCount).toBe(1);
    expect((await trpc.activity.list.query()).entries[0]).toMatchObject({
      action: "managedSkills.turnOff",
      result: "ok",
      subjects: [{ kind: "finding", id: skill?.id }],
      filesWritten: ["~/.claude/settings.json"],
    });
  });

  test("a claude.ai synced Skill is turned off with skillOverrides", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.skill(".claude/skills/synced/brand-voice", { name: "brand-voice" });

    await trpc.scan.run.mutate();
    const [skill] = (await trpc.inbox.list.query()).managedSkills[0]?.findings ?? [];
    expect(skill).toMatchObject({ agent: "claude-code", kind: "synced", plugin: null });
    await trpc.managedSkills.turnOff.mutate({ id: skill?.id ?? "", scope: "skill" });

    expect(JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8"))).toEqual({
      skillOverrides: { "brand-voice": "off" },
    });
    expect((await trpc.inbox.list.query()).count).toBe(0);
  });

  test("Cursor's Agent-managed Skills are listed read-only and never written", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.skill(".cursor/skills-cursor/create-rule", { name: "create-rule" });
    await fixture.skill(".cursor/plugins/cache/cursor-public/context7/abc123/skills/context7", { name: "context7" });
    await fixture.file(".cursor/cli-config.json", "{}\n");

    await trpc.scan.run.mutate();
    const inbox = await trpc.inbox.list.query();
    expect(inbox.managedSkills).toEqual([
      {
        agent: "cursor",
        findings: [
          expect.objectContaining({ name: "context7", kind: "plugin", plugin: "context7", offSwitches: [] }),
          expect.objectContaining({ name: "create-rule", kind: "bundled", offSwitches: [] }),
        ],
      },
    ]);
    const before = await snapshotTree(home, [".dark-matter"]);

    for (const finding of inbox.managedSkills[0]?.findings ?? []) {
      await expect(trpc.managedSkills.turnOff.mutate({ id: finding.id, scope: "skill" })).rejects.toMatchObject({
        data: { tag: "UnknownFinding" },
      });
    }

    expect(await snapshotTree(home, [".dark-matter"])).toEqual(before);
  });

  test("OpenCode: a skill permission deny rule is appended to opencode.jsonc, keeping comments", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.skill(".cache/opencode/skills/3f2a/review", { name: "Code review" });
    await fixture.file(
      ".config/opencode/opencode.jsonc",
      `{
  // my theme
  "theme": "tokyonight",
  "permissions": [
    { "action": "bash", "resource": "*", "effect": "ask" }, // careful
  ],
}
`,
    );

    await trpc.scan.run.mutate();
    const [skill] = (await trpc.inbox.list.query()).managedSkills[0]?.findings ?? [];
    expect(skill).toMatchObject({ agent: "opencode", kind: "cached", name: "Code review" });
    await trpc.managedSkills.turnOff.mutate({ id: skill?.id ?? "", scope: "skill" });

    const text = await readFile(join(home, ".config/opencode/opencode.jsonc"), "utf8");
    expect(text).toContain("// my theme");
    expect(text).toContain("// careful");
    expect(text).toContain('"theme": "tokyonight"');
    expect(text).toMatch(/\{\s*"action": "skill",\s*"resource": "review",\s*"effect": "deny"\s*\}/);
    expect((await trpc.inbox.list.query()).count).toBe(0);
  });

  test("OpenCode: a v1 config gets a permission.skill deny entry in its own shape", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.skill(".cache/opencode/skills/3f2a/review", { name: "review" });
    await fixture.file(".config/opencode/opencode.json", '{\n  "permission": { "edit": "ask" }\n}\n');

    await trpc.scan.run.mutate();
    const [skill] = (await trpc.inbox.list.query()).managedSkills[0]?.findings ?? [];
    await trpc.managedSkills.turnOff.mutate({ id: skill?.id ?? "", scope: "skill" });

    expect(JSON.parse(await readFile(join(home, ".config/opencode/opencode.json"), "utf8"))).toEqual({
      permission: { edit: "ask", skill: { review: "deny" } },
    });
  });

  const codexConfig = `# Codex settings
model = "gpt-5.5" # pinned

[projects."/Users/me/code/app"]
trust_level = "trusted"
`;

  test("Codex: one Skill is turned off with a [[skills.config]] entry, keeping comments and layout", async () => {
    const { fixture, trpc, home } = await setup();
    const skillDir = await fixture.skill(".codex/skills/.system/skill-creator", { name: "skill-creator" });
    await fixture.skill(".codex/plugins/cache/openai-curated/linear/1.0.0/skills/linear", { name: "linear" });
    await fixture.file(".codex/config.toml", codexConfig);

    await trpc.scan.run.mutate();
    const findings = (await trpc.inbox.list.query()).managedSkills[0]?.findings ?? [];
    expect(findings).toEqual([
      expect.objectContaining({ name: "linear", kind: "plugin", plugin: "linear@openai-curated" }),
      expect.objectContaining({
        name: "skill-creator",
        kind: "bundled",
        offSwitches: [
          {
            scope: "skill",
            file: "~/.codex/config.toml",
            setting: `[[skills.config]] path = ${JSON.stringify(join(skillDir, "SKILL.md"))}, enabled = false`,
          },
          { scope: "bundled", file: "~/.codex/config.toml", setting: "[skills.bundled] enabled = false" },
        ],
      }),
    ]);
    await trpc.managedSkills.turnOff.mutate({ id: findings[1]?.id ?? "", scope: "skill" });

    expect(await readFile(join(home, ".codex/config.toml"), "utf8")).toBe(
      `${codexConfig}\n[[skills.config]]\npath = ${JSON.stringify(join(skillDir, "SKILL.md"))}\nenabled = false\n`,
    );
    expect((await trpc.inbox.list.query()).managedSkills[0]?.findings.map((finding) => finding.name)).toEqual([
      "linear",
    ]);
  });

  test("Codex: every bundled Skill is turned off with [skills.bundled], next to existing entries", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.skill(".codex/skills/.system/skill-creator", { name: "skill-creator" });
    await fixture.skill(".codex/skills/.system/skill-installer", { name: "skill-installer" });
    const config = `${codexConfig}
[[skills.config]]
name = "pdf" # mine
enabled = false
`;
    await fixture.file(".codex/config.toml", config);

    await trpc.scan.run.mutate();
    const [first] = (await trpc.inbox.list.query()).managedSkills[0]?.findings ?? [];
    await trpc.managedSkills.turnOff.mutate({ id: first?.id ?? "", scope: "bundled" });

    expect(await readFile(join(home, ".codex/config.toml"), "utf8")).toBe(
      `${config}\n[skills.bundled]\nenabled = false\n`,
    );
    expect((await trpc.inbox.list.query()).managedSkills).toEqual([]);
  });

  test("Codex: a new [[skills.config]] entry goes after the existing ones", async () => {
    const { fixture, trpc, home } = await setup();
    const skillDir = await fixture.skill(".codex/skills/.system/skill-creator", { name: "skill-creator" });
    const config = `[[skills.config]]
name = "pdf" # mine
enabled = false

[mcp_servers.docs]
command = "docs-mcp"
`;
    await fixture.file(".codex/config.toml", config);

    await trpc.scan.run.mutate();
    const [skill] = (await trpc.inbox.list.query()).managedSkills[0]?.findings ?? [];
    await trpc.managedSkills.turnOff.mutate({ id: skill?.id ?? "", scope: "skill" });

    const text = await readFile(join(home, ".codex/config.toml"), "utf8");
    expect(text).toContain('name = "pdf" # mine');
    expect(text).toContain('[mcp_servers.docs]\ncommand = "docs-mcp"');
    expect(text).toContain(`[[skills.config]]\npath = ${JSON.stringify(join(skillDir, "SKILL.md"))}\nenabled = false`);
    expect((await trpc.inbox.list.query()).managedSkills).toEqual([]);
  });

  test("a Skill its Agent's settings already turn off is left out of the Inbox but still counted", async () => {
    const { fixture, trpc } = await setup();
    await fixture.claudePlugin("figma", "claude-plugins-official", "2.2.211", ["figma-use"]);
    await fixture.file(".claude/settings.json", '{ "enabledPlugins": { "figma@claude-plugins-official": false } }');
    await fixture.skill(".codex/skills/.system/skill-creator", { name: "skill-creator" });
    await fixture.file(".codex/config.toml", '[[skills.config]]\nname = "skill-creator"\nenabled = false\n');

    await trpc.scan.run.mutate();

    expect((await trpc.inbox.list.query()).managedSkills).toEqual([]);
    const cards = await trpc.agents.list.query();
    expect(cards.find((card) => card.id === "claude-code")?.managedSkillCount).toBe(1);
    expect(cards.find((card) => card.id === "codex")?.managedSkillCount).toBe(1);
  });

  test("a config that doesn't parse is never edited", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.skill(".claude/skills/synced/brand-voice", { name: "brand-voice" });
    await fixture.file(".claude/settings.json", '{ "model": "opus", ');
    await trpc.scan.run.mutate();
    const [skill] = (await trpc.inbox.list.query()).managedSkills[0]?.findings ?? [];

    await expect(trpc.managedSkills.turnOff.mutate({ id: skill?.id ?? "", scope: "skill" })).rejects.toMatchObject({
      data: { tag: "InvalidAgentConfig" },
    });

    expect(await readFile(join(home, ".claude/settings.json"), "utf8")).toBe('{ "model": "opus", ');
    expect((await trpc.activity.list.query()).entries[0]).toMatchObject({
      action: "managedSkills.turnOff",
      result: "error",
    });
  });

  test("a Scan reads Agent-managed locations without writing anything", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.claudePlugin("figma", "claude-plugins-official", "2.2.211", ["figma-use"]);
    await fixture.skill(".claude/skills/synced/brand-voice", { name: "brand-voice" });
    await fixture.skill(".cursor/skills-cursor/create-rule", { name: "create-rule" });
    await fixture.skill(".cache/opencode/skills/3f2a/review", { name: "review" });
    await fixture.skill(".codex/skills/.system/skill-creator", { name: "skill-creator" });
    await fixture.file(".codex/config.toml", codexConfig);
    const except = [".dark-matter/state", ".dark-matter/activity"];
    const before = await snapshotTree(home, except);

    await trpc.scan.run.mutate();

    expect(await snapshotTree(home, except)).toEqual(before);
    expect((await trpc.inbox.list.query()).count).toBe(5);
  });
});
