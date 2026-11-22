import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "./fixtures";

const write = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

test("Computer › Agents lists everything the Scan found, by owning folder, read-only ones with the reason", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home } = fixtureHome;
  await write(join(home, ".claude/skills/pdf/SKILL.md"), '---\nname: pdf\ndescription: "Work with PDFs"\n---\n');
  await write(join(home, ".agents/skills/csv/SKILL.md"), '---\nname: csv\ndescription: "Work with CSVs"\n---\n');
  await write(
    join(home, ".cursor/mcp.json"),
    JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } } }),
  );
  const window = await (await launchApp()).firstWindow();
  await window.getByTestId("sidebar").getByRole("link", { name: "Agents" }).click();
  await expect(window.getByText("Not scanned yet.")).toBeVisible();

  await window.getByRole("button", { name: "Scan now" }).click();

  const groups = window.getByTestId("inventory-group");
  await expect(groups).toHaveCount(3);
  expect(await groups.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-folder")))).toEqual([
    "~/.agents/skills",
    "~/.claude/skills",
    "~/.cursor/mcp.json",
  ]);
  const item = (name: string) => window.getByTestId("inventory-item").filter({ hasText: name });
  await expect(item("csv").getByTestId("inventory-read-only")).toBeHidden();
  await expect(item("csv").getByTestId("inventory-agents")).toHaveText("Seen by Cursor, OpenCode, Codex, .agents");
  await expect(item("pdf").getByTestId("inventory-read-only")).toBeVisible();
  await expect(item("pdf").getByTestId("inventory-reason")).toContainText("Claude Code's Adopt Permission is off");
  await expect(item("linear")).toContainText("https://mcp.linear.app/mcp");
  await expect(item("linear").getByTestId("inventory-reason")).toContainText("Agent Config Guard is on");

  // Allowing Claude Code's Skills in Settings makes its Skills adoptable here too.
  await window.getByRole("link", { name: "Settings" }).click();
  await window.getByRole("switch", { name: "Allow moving Skills from Claude Code" }).click();
  await window.getByTestId("sidebar").getByRole("link", { name: "Agents" }).click();
  await expect(item("pdf").getByTestId("inventory-read-only")).toBeHidden();
  await expect(item("linear").getByTestId("inventory-read-only")).toBeVisible();
});
