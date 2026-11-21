// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${secret:…}` and `${VAR}` are MCP references, not templates.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const readOrNull = (path: string) => readFile(path, "utf8").catch(() => null);

test("a Library MCP Server added as Shared lists the env vars to set, and turning it Off warns it's a team change", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  await mkdir(join(libraryHome, "mcp"), { recursive: true });
  await writeFile(
    join(libraryHome, "mcp/linear.json"),
    JSON.stringify({
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer ${secret:linear.Authorization}" },
    }),
  );
  const app = join(home, "code", "app");
  await mkdir(app, { recursive: true });
  execFileSync("git", ["init", "--quiet", app]);
  await writeFile(
    join(libraryHome, "projects.json"),
    JSON.stringify({ projects: { [app]: { agents: ["claude-code"] } } }),
  );
  const config = join(app, ".mcp.json");

  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();
  await window.getByTestId("sidebar").getByTestId("sidebar-project").click();
  await window.getByRole("button", { name: "Add MCP Servers" }).click();
  const dialog = window.getByRole("dialog", { name: "Add MCP Servers" });
  await dialog.getByRole("radio", { name: "Shared" }).click();
  await expect(dialog.getByTestId("mcp-target")).toContainText("~/code/app/.mcp.json");
  await dialog.getByTestId("add-mcp-option").filter({ hasText: "linear" }).getByRole("checkbox").click();
  await dialog.getByRole("button", { name: "Review 1 MCP Server" }).click();
  // The dry run: a team change, and what each teammate must set.
  await expect(dialog.getByTestId("mcp-plan")).toContainText("This is a team change");
  await expect(dialog.getByTestId("mcp-env-vars")).toContainText("LINEAR_AUTHORIZATION");
  await expect(dialog.getByTestId("mcp-plan-edit").first()).toHaveText("~/code/app/.mcp.json: write mcpServers.linear");
  expect(await readOrNull(config)).toBeNull();
  await dialog.getByRole("button", { name: "Add 1 MCP Server" }).click();

  const row = window.getByTestId("project-mcp-row");
  await expect(row.getByTestId("project-mcp-mode")).toHaveText("Shared");
  await expect(row.getByTestId("mcp-env-vars")).toContainText("LINEAR_AUTHORIZATION");
  await expect.poll(() => readOrNull(config)).toContain("Bearer ${LINEAR_AUTHORIZATION}");

  await row.getByRole("switch").click();
  const confirm = window.getByRole("dialog", { name: "Turn off linear for the team?" });
  await expect(confirm.getByTestId("mcp-plan")).toContainText("This is a team change");
  await confirm.getByRole("button", { name: "Turn Off" }).click();
  await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => readOrNull(config)).toBeNull();
});
