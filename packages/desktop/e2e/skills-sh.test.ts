import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startFakeGitHub } from "./fake-github";
import { startFakeSkillsSh } from "./fake-skills-sh";
import { expect, test } from "./fixtures";

const linkTarget = (path: string) =>
  lstat(path).then(
    (info) => (info.isSymbolicLink() ? readlink(path) : null),
    () => null,
  );

test("⌘K starts a skills.sh search; Get Imports the listing and offers Add to Projects", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  const github = await startFakeGitHub(join(home, "..", "github"), "acme/skills", {
    "skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Work with PDFs\n---\n# PDF tools\n",
    "skills/xlsx/SKILL.md": "---\nname: xlsx\ndescription: Work with spreadsheets\n---\n",
  });
  const skillsSh = await startFakeSkillsSh([
    { source: "acme/skills", skillId: "pdf", installs: 1200 },
    { source: "acme/skills", skillId: "xlsx", installs: 3 },
  ]);
  fixtureHome.env.DARK_MATTER_GITHUB_API = github.api;
  fixtureHome.env.DARK_MATTER_SKILLS_SH_API = skillsSh.api;
  const app = join(home, "code", "app");
  await mkdir(app, { recursive: true });
  execFileSync("git", ["init", "--quiet", app]);
  await mkdir(libraryHome, { recursive: true });
  await writeFile(join(libraryHome, "projects.json"), JSON.stringify({ projects: { [app]: { agents: ["codex"] } } }));

  try {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await expect(window.getByTestId("sidebar").getByTestId("sidebar-project")).toBeVisible();
    await window.keyboard.press("ControlOrMeta+k");
    await window.getByTestId("command-palette").getByRole("combobox").fill("pdf");
    await window.getByRole("option", { name: "Search skills.sh for “pdf”" }).click();

    await expect(window.getByRole("textbox", { name: "Search skills.sh" })).toHaveValue("pdf");
    const pdf = window.getByTestId("skills-sh-result").filter({ hasText: "acme/skills" });
    await expect(pdf).toHaveCount(1);
    await expect(pdf).toContainText(/1\.2k installs/i);
    await pdf.getByRole("button", { name: "Preview" }).click();
    await expect(pdf.getByTestId("skills-sh-preview")).toContainText("PDF tools");
    await pdf.getByRole("button", { name: "Get pdf" }).click();

    const grid = window.getByRole("dialog", { name: "Add the new Skill to Projects" });
    await grid.getByRole("checkbox", { name: "pdf in app" }).check();
    await grid.getByRole("button", { name: "Add 1 Link" }).click();
    await expect
      .poll(() => linkTarget(join(app, ".agents/skills/pdf")))
      .toBe(join(libraryHome, "skills/acme/skills/pdf"));
    await expect(pdf.getByRole("link", { name: "in Library" })).toBeVisible();
    const lock = JSON.parse(await readFile(join(libraryHome, "library-lock.json"), "utf8"));
    expect(lock.skills["acme/skills/pdf"]).toMatchObject({ source: "acme/skills", commit: github.head });

    // A Project's Add Skills dialog searches skills.sh too; Get adds the Skill to that Project.
    await window.getByTestId("sidebar").getByTestId("sidebar-project").click();
    await window.getByRole("button", { name: "Add Skills" }).click();
    await window.getByRole("textbox", { name: "Search the Library or paste a GitHub URL" }).fill("xlsx");
    await window.getByRole("region", { name: "From skills.sh" }).getByRole("button", { name: "Get xlsx" }).click();
    await expect
      .poll(() => linkTarget(join(app, ".agents/skills/xlsx")))
      .toBe(join(libraryHome, "skills/acme/skills/xlsx"));
  } finally {
    await github.close();
    await skillsSh.close();
  }
});
