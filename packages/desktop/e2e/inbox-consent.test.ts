import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "./fixtures";

const write = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

const skill = (dir: string, name: string) => write(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n\nUse it.\n`);

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

test("the Inbox pre-selects nothing, Adopts only what you tick, and shows why the rest is read-only", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  await skill(join(home, ".agents/skills/notes"), "notes");
  await skill(join(home, ".agents/skills/todo"), "todo");
  await skill(join(home, ".claude/skills/pdf"), "pdf");
  await write(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { "github-tools": { type: "stdio", command: "npx", args: ["github-tools"] } } }),
  );
  const window = await (await launchApp()).firstWindow();
  await window.getByRole("button", { name: "Scan now" }).click();
  await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();

  // Nothing is ticked; the Adopt button for ticked Skills waits for a tick.
  const row = (name: string) => window.getByTestId("inbox-finding").filter({ hasText: name });
  await expect(row("notes").getByRole("checkbox", { name: "notes" })).not.toBeChecked();
  await expect(row("todo").getByRole("checkbox", { name: "todo" })).not.toBeChecked();
  await expect(
    window.getByTestId("inbox-skills-actions").getByRole("button", { name: "Adopt ticked", exact: true }),
  ).toBeDisabled();

  // pdf is read-only: Claude Code's Adopt Permission is off.
  await expect(row("pdf").getByRole("checkbox", { name: "pdf" })).toBeDisabled();
  await expect(row("pdf").getByTestId("read-only-reason")).toContainText("Claude Code's Adopt Permission is off");
  await expect(row("pdf").getByRole("button", { name: "Adopt" })).toHaveCount(0);

  // So is the Global MCP Server, while the Agent Config Guard is on.
  const server = window.getByTestId("inbox-mcp-finding").filter({ hasText: "github-tools" });
  await expect(server.getByTestId("read-only-reason")).toContainText("Agent Config Guard is on");
  await expect(server.getByRole("checkbox", { name: "github-tools" })).toBeDisabled();
  await expect(server.getByRole("button", { name: "Adopt" })).toHaveCount(0);

  // Tick one → its plan → confirm: only that one moves.
  await row("todo").getByRole("checkbox", { name: "todo" }).check();
  await window.getByTestId("inbox-skills-actions").getByRole("button", { name: "Adopt 1 ticked" }).click();
  const plan = window.getByRole("dialog", { name: "Adopt 1 Skill" });
  await expect(plan).toContainText("todo");
  await expect(plan).not.toContainText("notes");
  await plan.getByRole("button", { name: "Adopt", exact: true }).click();
  await expect(row("todo")).toBeHidden();
  expect(await exists(join(libraryHome, "skills/local/todo"))).toBe(true);
  expect(await exists(join(home, ".agents/skills/notes"))).toBe(true);
  expect(await exists(join(home, ".claude/skills/pdf"))).toBe(true);
  await expect(row("notes").getByRole("checkbox", { name: "notes" })).not.toBeChecked();

  // Allowing Claude Code in Settings makes pdf tickable, still unticked.
  await window.getByRole("link", { name: "Settings" }).click();
  await window.getByRole("switch", { name: "Allow moving Skills from Claude Code" }).click();
  await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();
  await expect(row("pdf").getByRole("checkbox", { name: "pdf" })).toBeEnabled();
  await expect(row("pdf").getByRole("checkbox", { name: "pdf" })).not.toBeChecked();
  await expect(row("pdf").getByTestId("read-only-reason")).toHaveCount(0);
});

test("Agent-managed off switches are disabled with the reason while the Agent Config Guard is on", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home } = fixtureHome;
  await skill(join(home, ".codex/skills/.system/skill-creator"), "skill-creator");
  await write(join(home, ".codex/config.toml"), 'model = "gpt-5.5"\n');
  const plugin = join(home, ".claude/plugins/cache/claude-plugins-official/figma/2.2.211");
  await write(
    join(plugin, ".mcp.json"),
    JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } } }),
  );
  await write(
    join(home, ".claude/plugins/installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "figma@claude-plugins-official": [{ installPath: plugin }] } }),
  );
  await write(join(home, ".claude/settings.json"), "{}\n");
  const window = await (await launchApp()).firstWindow();
  await window.getByRole("button", { name: "Scan now" }).click();
  await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();

  const managedSkill = window.getByTestId("inbox-managed-finding").filter({ hasText: "skill-creator" });
  const figma = window.getByTestId("managed-mcp-server").filter({ hasText: "plugin:figma:figma" });
  await expect(managedSkill.getByRole("button", { name: "Turn off everywhere" })).toBeDisabled();
  await expect(managedSkill.getByTestId("guarded-reason")).toContainText("Agent Config Guard is on");
  await expect(figma.getByRole("button", { name: "Turn off plugin everywhere" })).toBeDisabled();
  await expect(figma.getByTestId("guarded-reason")).toContainText("Agent Config Guard is on");

  // Turning the Guard off in Settings enables them.
  await window.getByRole("link", { name: "Settings" }).click();
  await window.getByRole("switch", { name: "Never edit Agent config files" }).click();
  await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();
  await expect(managedSkill.getByRole("button", { name: "Turn off everywhere" })).toBeEnabled();
  await expect(managedSkill.getByTestId("guarded-reason")).toHaveCount(0);
  await expect(figma.getByRole("button", { name: "Turn off plugin everywhere" })).toBeEnabled();
});
