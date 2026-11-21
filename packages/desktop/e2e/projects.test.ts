import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

test("a Suggested Project from Claude Code's history can be managed, given Agents and located after a move", async ({
  launchApp,
  fixtureHome,
}) => {
  const app = join(fixtureHome.home, "code", "app");
  await mkdir(app, { recursive: true });
  execFileSync("git", ["init", "--quiet", app]);
  await writeFile(join(fixtureHome.home, ".claude.json"), JSON.stringify({ projects: { [app]: {} } }));
  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();
  const sidebar = window.getByTestId("sidebar");

  await window.getByRole("button", { name: "Scan now" }).click();
  await expect(window.getByTestId("suggested-badge")).toHaveText("1");
  await sidebar.getByRole("link", { name: /Suggested/ }).click();
  const row = window.getByTestId("suggested-project");
  await expect(row).toContainText("app");
  await expect(row).toContainText("Claude Code");

  await row.getByRole("button", { name: "Manage" }).click();

  await expect(window.getByRole("heading", { name: "app" })).toBeVisible();
  await expect(sidebar.getByTestId("sidebar-project")).toHaveText("app");
  await expect(window.getByTestId("suggested-badge")).toBeHidden();
  await expect(window.getByTestId("project-folders")).toHaveText(/\.claude\/skills/);
  await window.getByTestId("agent-option").filter({ hasText: "Codex" }).getByRole("checkbox").click();
  await expect(window.getByTestId("project-folders")).toHaveText(/\.agents\/skills.*\.claude\/skills/);

  const moved = join(fixtureHome.home, "work", "app");
  await mkdir(join(fixtureHome.home, "work"));
  await rename(app, moved);
  await window.reload();
  await expect(window.getByTestId("project-gone")).toBeVisible();
  await expect(sidebar.getByLabel("Folder gone")).toBeVisible();
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, moved);

  await window.getByRole("button", { name: "Locate…" }).click();

  await expect(window.getByTestId("project-gone")).toBeHidden();
  // The first match is the page head; the Project's Activity below names the path too.
  await expect(window.getByText(/~\/work\/app|work\/app/).first()).toBeVisible();
  await expect(sidebar.getByLabel("Folder gone")).toBeHidden();
});
