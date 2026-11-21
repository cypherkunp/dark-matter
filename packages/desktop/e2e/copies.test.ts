import { execFileSync } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const isFolder = (path: string) =>
  lstat(path).then(
    (info) => info.isDirectory() && !info.isSymbolicLink(),
    () => false,
  );

test("a Skill added as a Copy shows 'modified in repo' when edited, asks before Off, and appears on the Skill page's Projects tab", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  const skill = join(libraryHome, "skills/local/pdf");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), '---\nname: "pdf"\ndescription: "Work with PDFs"\n---\n');
  await writeFile(
    join(libraryHome, "library-lock.json"),
    JSON.stringify({
      version: 1,
      skills: { "local/pdf": { source: "local", sourceType: "local", computedHash: "0" } },
    }),
  );
  const app = join(home, "code", "app");
  await mkdir(app, { recursive: true });
  execFileSync("git", ["init", "--quiet", app]);
  await writeFile(join(libraryHome, "projects.json"), JSON.stringify({ projects: { [app]: { agents: ["codex"] } } }));
  const copy = join(app, ".agents/skills/pdf");

  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();
  await window.getByTestId("sidebar").getByTestId("sidebar-project").click();
  await window.getByRole("button", { name: "Add Skills" }).click();
  await window.getByRole("radio", { name: "Copy" }).check();
  await window.getByTestId("add-skill-option").filter({ hasText: "pdf" }).getByRole("checkbox").click();
  await window.getByRole("button", { name: "Add 1 Skill" }).click();

  const row = window.getByTestId("project-skill-row");
  await expect(row.getByTestId("delivery-mode")).toHaveText("Copy");
  await expect.poll(() => isFolder(copy)).toBe(true);

  await writeFile(join(copy, "notes.md"), "edited in the repo\n");
  await window.reload();
  await expect(row.getByTestId("copy-state")).toHaveText("modified in repo");
  await row.getByRole("button", { name: "Diff" }).click();
  await expect(window.getByTestId("copy-diff")).toContainText("+edited in the repo");
  await window.getByRole("button", { name: "Close" }).click();

  await row.getByRole("switch").click();
  const confirm = window.getByRole("dialog");
  await expect(confirm).toContainText("git will show the deletion");
  await expect(confirm).toContainText("those edits will be lost");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  expect(await isFolder(copy)).toBe(true);

  await row.getByRole("button", { name: "Pull into Library" }).click();
  await expect(row.getByTestId("copy-state")).toHaveCount(0);

  await window.getByTestId("sidebar").getByTestId("sidebar-namespace").first().click();
  await window.getByTestId("library-skill").filter({ hasText: "pdf" }).click();
  await window.getByRole("tab", { name: "Projects" }).click();
  const use = window.getByTestId("skill-project-row");
  await expect(use).toContainText("app");
  await expect(use.getByTestId("delivery-mode")).toHaveText("Copy");
  await use.getByRole("switch").click();
  await window.getByRole("dialog").getByRole("button", { name: "Turn Off" }).click();
  await expect(use.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => isFolder(copy)).toBe(false);
});
