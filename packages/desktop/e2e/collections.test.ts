import { execFileSync } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const kind = (path: string) =>
  lstat(path).then(
    (info) => (info.isSymbolicLink() ? "link" : info.isDirectory() ? "folder" : "file"),
    () => null,
  );

test("a Collection is created under Library and added to a Project with Link or Copy per Skill", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  const skills: Record<string, unknown> = {};
  for (const name of ["pdf", "docx"]) {
    const folder = join(libraryHome, "skills/local", name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), `---\nname: "${name}"\ndescription: "Work with ${name}"\n---\n`);
    skills[`local/${name}`] = { source: "local", sourceType: "local", computedHash: "0" };
  }
  await writeFile(join(libraryHome, "library-lock.json"), JSON.stringify({ version: 1, skills }));
  const app = join(home, "code", "app");
  await mkdir(app, { recursive: true });
  execFileSync("git", ["init", "--quiet", app]);
  await writeFile(join(libraryHome, "projects.json"), JSON.stringify({ projects: { [app]: { agents: ["codex"] } } }));

  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();
  await window
    .getByTestId("sidebar")
    .getByRole("link", { name: /^Collections/ })
    .click();
  await window.getByLabel("New Collection name").fill("docs kit");
  await window.getByRole("button", { name: "Create" }).click();

  await window.getByRole("button", { name: "Add Skills" }).click();
  for (const name of ["pdf", "docx"])
    await window.getByTestId("collection-skill-option").filter({ hasText: name }).getByRole("checkbox").click();
  await window.getByRole("button", { name: "Add 2 Skills" }).click();
  await expect(window.getByTestId("collection-item")).toHaveCount(2);
  await expect(window.getByTestId("sidebar-collection")).toContainText("docs kit");

  await window.getByRole("button", { name: "+ Add to Projects" }).click();
  const grid = window.getByTestId("add-to-projects-grid");
  await grid.getByRole("radiogroup", { name: "Deliver docx as" }).getByText("Copy").click();
  await grid.getByRole("button", { name: "app" }).click();
  await window.getByRole("button", { name: "Add 2 Skills" }).click();

  await expect.poll(() => kind(join(app, ".agents/skills/pdf"))).toBe("link");
  await expect.poll(() => kind(join(app, ".agents/skills/docx"))).toBe("folder");
});
