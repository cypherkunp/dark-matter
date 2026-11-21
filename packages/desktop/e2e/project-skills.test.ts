import { execFileSync } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const isLink = (path: string) =>
  lstat(path).then(
    (info) => info.isSymbolicLink(),
    () => false,
  );

test("a Library Skill added to a Project as a Link can be turned Off and On", async ({ launchApp, fixtureHome }) => {
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
  const link = join(app, ".agents/skills/pdf");

  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();
  await window.getByTestId("sidebar").getByTestId("sidebar-project").click();
  await window.getByRole("button", { name: "Add Skills" }).click();
  await window.getByTestId("add-skill-option").filter({ hasText: "pdf" }).getByRole("checkbox").click();
  await window.getByRole("button", { name: "Add 1 Skill" }).click();

  const row = window.getByTestId("project-skill-row");
  await expect(row).toContainText("pdf");
  await expect(row).toContainText("Link");
  await expect.poll(() => isLink(link)).toBe(true);

  await row.getByRole("switch").click();
  await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => isLink(link)).toBe(false);

  await row.getByRole("switch").click();
  await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => isLink(link)).toBe(true);

  await window
    .getByTestId("sidebar")
    .getByRole("link", { name: /All Skills/ })
    .click();
  await expect(window.getByTestId("library-skill").getByTestId("project-count")).toHaveText("1 Project");
});
