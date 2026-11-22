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

test("untracked Project MCP entries are ticked to Adopt as Personal, read-only while the Guard is on", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  const app = join(home, "code", "app");
  await mkdir(join(app, ".cursor"), { recursive: true });
  execFileSync("git", ["init", "--quiet", app]);
  await writeFile(join(libraryHome, "projects.json"), JSON.stringify({ projects: { [app]: { agents: ["cursor"] } } }));
  await writeFile(
    join(app, ".cursor/mcp.json"),
    JSON.stringify({ mcpServers: { notes: { command: "notes" }, todo: { command: "todo" } } }),
  );

  const window = await (await launchApp()).firstWindow();
  const sidebar = window.getByTestId("sidebar");
  await sidebar.getByTestId("sidebar-project").click();
  const entry = (name: string) => window.getByTestId("repo-mcp-untracked").filter({ hasText: name });

  // The Agent Config Guard is on: nothing can be ticked, and each says why.
  await expect(entry("notes").getByRole("checkbox", { name: "notes" })).toBeDisabled();
  await expect(entry("notes").getByTestId("read-only-reason")).toContainText("Agent Config Guard is on");
  await expect(window.getByRole("button", { name: "Adopt ticked as Personal" })).toBeDisabled();

  await sidebar.getByRole("link", { name: "Settings" }).click();
  const settings = window.getByTestId("agents-settings");
  await settings.getByRole("switch", { name: "Never edit Agent config files" }).click();
  await settings.getByRole("switch", { name: "Allow moving MCP Servers from Cursor" }).click();
  await expect(settings.getByRole("switch", { name: "Allow moving MCP Servers from Cursor" })).toBeChecked();
  await sidebar.getByTestId("sidebar-project").click();

  // Now they can be ticked, but nothing is pre-selected; only what's ticked moves.
  for (const name of ["notes", "todo"]) {
    await expect(entry(name).getByRole("checkbox", { name })).toBeEnabled();
    await expect(entry(name).getByRole("checkbox", { name })).not.toBeChecked();
  }
  await entry("notes").getByRole("checkbox", { name: "notes" }).check();
  await window.getByRole("button", { name: "Adopt 1 ticked as Personal" }).click();
  const plan = window.getByRole("dialog", { name: "Adopt 1 MCP Server" });
  await plan.getByRole("button", { name: "Adopt", exact: true }).click();

  await expect(window.getByTestId("project-mcp-row").filter({ hasText: "notes" })).toContainText("Personal");
  await expect(entry("todo")).toBeVisible();
  await expect(entry("notes")).toHaveCount(0);
  await expect.poll(() => readOrNull(join(libraryHome, "mcp/notes.json"))).not.toBeNull();
  expect(await readOrNull(join(libraryHome, "mcp/todo.json"))).toBeNull();
});
