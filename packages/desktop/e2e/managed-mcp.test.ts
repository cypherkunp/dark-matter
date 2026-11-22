import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allowAdoptEverywhere, expect, test } from "./fixtures";

// Tests Adopt and the off switches themselves; their gating (ADR-0007) is in inbox-consent and first-run.
test.use({ preferences: allowAdoptEverywhere });

test("Agent-managed MCP Servers are listed read-only and a plugin's are turned off through Claude Code's settings", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home } = fixtureHome;
  const plugin = join(home, ".claude/plugins/cache/claude-plugins-official/figma/2.2.211");
  await mkdir(plugin, { recursive: true });
  await writeFile(
    join(plugin, ".mcp.json"),
    JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } } }),
  );
  await writeFile(
    join(home, ".claude/plugins/installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "figma@claude-plugins-official": [{ installPath: plugin }] } }),
  );
  await writeFile(join(home, ".claude/settings.json"), '{\n  "model": "opus"\n}\n');
  const cursor = join(home, ".cursor/plugins/cache/cursor-public/context7/33414e");
  await mkdir(cursor, { recursive: true });
  await writeFile(join(cursor, "mcp.json"), JSON.stringify({ mcpServers: { context7: { url: "https://x.dev/mcp" } } }));
  const app = await launchApp();
  const window = await app.firstWindow();

  await window.getByRole("button", { name: "Scan now" }).click();
  await expect(window.getByTestId("inbox-badge")).toHaveText("2");
  await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();
  const readOnly = window.getByTestId("managed-mcp-server").filter({ hasText: "plugin-context7-context7" });
  await expect(readOnly).toContainText("Cursor Settings");
  await expect(readOnly.getByRole("button", { name: /Turn off/ })).toHaveCount(0);

  const figma = window.getByTestId("managed-mcp-server").filter({ hasText: "plugin:figma:figma" });
  await figma.getByRole("button", { name: "Turn off plugin everywhere" }).click();

  await expect(figma).toBeHidden();
  await expect(window.getByTestId("inbox-badge")).toHaveText("1");
  expect(await readFile(join(home, ".claude/settings.json"), "utf8")).toBe(
    '{\n  "model": "opus",\n  "enabledPlugins": {\n    "figma@claude-plugins-official": false\n  }\n}\n',
  );
  await window.getByTestId("sidebar").getByRole("link", { name: "MCP Servers" }).click();
  await expect(window.getByTestId("managed-mcp-server").filter({ hasText: "plugin:figma:figma" })).toContainText("Off");
});
