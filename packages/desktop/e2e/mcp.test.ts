import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allowAdoptEverywhere, expect, test } from "./fixtures";

// Tests Adopt and the off switches themselves; their gating (ADR-0007) is in inbox-consent and first-run.
test.use({ preferences: allowAdoptEverywhere });

test("Adopt moves a Global MCP Server into the Library and out of the Agent's config", async ({
  launchApp,
  fixtureHome,
}) => {
  const config = join(fixtureHome.home, ".cursor", "mcp.json");
  await mkdir(join(fixtureHome.home, ".cursor"), { recursive: true });
  await writeFile(
    config,
    `{
  "mcpServers": {
    "linear": { "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer lin_secret" } },
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
  }
}
`,
  );
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByRole("button", { name: "Scan now" }).click();
  await expect(window.getByTestId("inbox-badge")).toHaveText("2");
  const sidebar = window.getByTestId("sidebar");

  await sidebar.getByRole("link", { name: /Agents/ }).click();
  const cursor = window.getByTestId("agent-card").filter({ hasText: "Cursor" });
  await expect(cursor.getByTestId("agent-mcp-config")).toContainText("~/.cursor/mcp.json");

  await sidebar.getByRole("link", { name: /Inbox/ }).click();
  await window
    .getByTestId("inbox-mcp-finding")
    .filter({ hasText: "linear" })
    .getByRole("button", { name: "Adopt" })
    .click();
  const plan = window.getByRole("dialog", { name: "Adopt 1 MCP Server" });
  await expect(plan).toContainText("store Secret linear.Authorization in the keychain");
  await expect(plan).toContainText("~/.dark-matter/mcp/linear.json");
  await expect(plan).not.toContainText("lin_secret");
  await plan.getByRole("button", { name: "Adopt", exact: true }).click();

  await expect(window.getByTestId("inbox-badge")).toHaveText("1");
  await sidebar.getByRole("link", { name: /MCP Servers/ }).click();
  const server = window.getByTestId("library-mcp-server");
  await expect(server).toContainText("linear");
  await expect(server).toContainText("linear.Authorization");
  await expect.poll(async () => (await readFile(config, "utf8")).includes("linear")).toBe(false);

  await server.getByRole("button", { name: "Undo Adopt" }).click();
  await expect(window.getByTestId("mcp-empty")).toBeVisible();
  await expect.poll(async () => (await readFile(config, "utf8")).includes("Bearer lin_secret")).toBe(true);
});
