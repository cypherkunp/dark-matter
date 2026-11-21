import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startFakeGitHub } from "./fake-github";
import { expect, test } from "./fixtures";

const linkTarget = (path: string) =>
  lstat(path).then(
    (info) => (info.isSymbolicLink() ? readlink(path) : null),
    () => null,
  );

test("a GitHub URL pasted into a Project's Add Skills imports the picked Skill and adds it to that Project", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  const github = await startFakeGitHub(join(home, "..", "github"), "acme/skills", {
    "skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Work with PDFs\n---\n# PDF tools\n",
    "skills/xlsx/SKILL.md": "---\nname: xlsx\ndescription: Work with spreadsheets\n---\n",
  });
  fixtureHome.env.DARK_MATTER_GITHUB_API = github.api;
  const app = join(home, "code", "app");
  await mkdir(app, { recursive: true });
  execFileSync("git", ["init", "--quiet", app]);
  await mkdir(libraryHome, { recursive: true });
  await writeFile(join(libraryHome, "projects.json"), JSON.stringify({ projects: { [app]: { agents: ["codex"] } } }));

  try {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.getByTestId("sidebar").getByTestId("sidebar-project").click();
    await window.getByRole("button", { name: "Add Skills" }).click();
    await window
      .getByRole("textbox", { name: "Search the Library or paste a GitHub URL" })
      .fill("https://github.com/acme/skills");
    await window.getByRole("button", { name: /Import .* from GitHub/ }).click();

    const candidates = window.getByTestId("import-candidate");
    await expect(candidates).toHaveCount(2);
    // A multi-Skill repo starts with nothing ticked.
    await expect(window.getByRole("button", { name: "Import 0 Skills" })).toBeDisabled();
    const pdf = candidates.filter({ hasText: "pdf" });
    await pdf.getByRole("button", { name: "Preview" }).click();
    await expect(pdf.getByTestId("import-preview")).toContainText("PDF tools");
    await pdf.getByRole("checkbox", { name: "Import pdf" }).check();
    await window.getByRole("button", { name: "Import 1 Skill" }).click();

    const grid = window.getByRole("dialog", { name: "Add the Imported Skills to Projects" });
    await expect(grid.getByRole("checkbox", { name: "pdf in app" })).toBeChecked();
    await grid.getByRole("button", { name: "Add 1 Link" }).click();

    await expect
      .poll(() => linkTarget(join(app, ".agents/skills/pdf")))
      .toBe(join(libraryHome, "skills/acme/skills/pdf"));
    const lock = JSON.parse(await readFile(join(libraryHome, "library-lock.json"), "utf8"));
    expect(lock.skills["acme/skills/pdf"]).toMatchObject({ source: "acme/skills", ref: "main", commit: github.head });
  } finally {
    await github.close();
  }
});
