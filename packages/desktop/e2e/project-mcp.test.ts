// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${secret:…}` is an MCP reference, not a template.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const readOrNull = (path: string) => readFile(path, "utf8").catch(() => null);

test("a Library MCP Server added to a Project as Personal gets its Secret, and can be turned Off", async ({
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
  await writeFile(join(libraryHome, "projects.json"), JSON.stringify({ projects: { [app]: { agents: ["cursor"] } } }));
  const config = join(app, ".cursor/mcp.json");

  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();
  const sidebar = window.getByTestId("sidebar");

  // The Secret isn't in the keychain yet: enter it on the MCP Servers screen.
  await sidebar.getByRole("link", { name: /MCP Servers/ }).click();
  const secret = window.getByTestId("mcp-secret");
  await expect(secret).toContainText("not in the keychain");
  await secret.getByRole("button", { name: "Enter" }).click();
  await secret.getByLabel("Value of linear.Authorization").fill("lin_e2e");
  await secret.getByRole("button", { name: "Save" }).click();
  await expect(secret).not.toContainText("not in the keychain");

  await sidebar.getByTestId("sidebar-project").click();
  await window.getByRole("button", { name: "Add MCP Servers" }).click();
  const dialog = window.getByRole("dialog", { name: "Add MCP Servers" });
  await expect(dialog.getByTestId("mcp-target")).toContainText("~/code/app/.cursor/mcp.json");
  await dialog.getByTestId("add-mcp-option").filter({ hasText: "linear" }).getByRole("checkbox").click();
  await dialog.getByRole("button", { name: "Add 1 MCP Server" }).click();

  const row = window.getByTestId("project-mcp-row");
  await expect(row).toContainText("Personal");
  await expect(row.getByTestId("project-mcp-delivery")).toContainText("Cursor ~/code/app/.cursor/mcp.json");
  await expect(row.getByTestId("mcp-approval")).toHaveText("needs approval in Cursor");
  await expect.poll(() => readOrNull(config)).toContain("Bearer lin_e2e");

  await row.getByRole("switch").click();
  await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => readOrNull(config)).toBeNull();
});
