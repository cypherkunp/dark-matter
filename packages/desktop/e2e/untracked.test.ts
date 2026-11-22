import { execFileSync } from "node:child_process";
import { mkdir, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allowAdoptEverywhere, expect, test } from "./fixtures";

// Tests Adopt and the off switches themselves; their gating (ADR-0007) is in inbox-consent and first-run.
test.use({ preferences: allowAdoptEverywhere });

const linkTarget = (path: string) => readlink(path).catch(() => null);

const skill = async (dir: string, name: string) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: "About ${name}"\n---\n\nUse it.\n`);
};

/** A git repo confirmed as a Project (written before launch). */
const project = async (libraryHome: string, path: string) => {
  await mkdir(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
  await writeFile(join(libraryHome, "projects.json"), JSON.stringify({ projects: { [path]: { agents: ["codex"] } } }));
};

test("an untracked Project Skill is flagged on its Project and Adopted with its Link kept", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  const app = join(home, "code", "app");
  await mkdir(libraryHome, { recursive: true });
  await project(libraryHome, app);
  await skill(join(app, ".agents/skills/pdf"), "pdf");

  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();
  await window.getByRole("button", { name: "Scan now" }).click();
  await expect(window.getByTestId("inbox-badge")).toHaveText("1");
  await window.getByTestId("sidebar").getByTestId("sidebar-project").click();
  await window.getByTestId("project-untracked").click();

  await window.getByTestId("inbox-untracked-finding").getByRole("button", { name: "Adopt & keep Link" }).click();
  const plan = window.getByRole("dialog", { name: "Adopt & keep Link 1 Skill" });
  await expect(plan).toContainText("~/code/app/.agents/skills/pdf");
  await plan.getByRole("button", { name: "Adopt", exact: true }).click();

  await expect(window.getByTestId("inbox-empty")).toBeVisible();
  await expect.poll(() => linkTarget(join(app, ".agents/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
});

test("after Adopting Global Skills the Add to Projects grid links them into Projects; the Skill page opens it too", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  const app = join(home, "code", "app");
  await mkdir(libraryHome, { recursive: true });
  await project(libraryHome, app);
  await skill(join(home, ".claude/skills/pdf"), "pdf");
  await skill(join(home, ".claude/skills/lint"), "lint");

  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();
  await window.getByRole("button", { name: "Scan now" }).click();
  await expect(window.getByTestId("inbox-badge")).toHaveText("2");
  await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();
  // Nothing is pre-selected: tick both, then Adopt what's ticked.
  for (const name of ["pdf", "lint"]) await window.getByRole("checkbox", { name, exact: true }).check();
  await window.getByTestId("inbox-skills-actions").getByRole("button", { name: "Adopt 2 ticked" }).click();
  await window
    .getByRole("dialog", { name: "Adopt 2 Skills" })
    .getByRole("button", { name: "Adopt", exact: true })
    .click();

  const grid = window.getByRole("dialog", { name: "Add to Projects" });
  await expect(grid.getByTestId("add-to-projects-row")).toHaveCount(2);
  await grid.getByRole("checkbox", { name: "pdf in app" }).check();
  await grid.getByRole("button", { name: "Add 1 Link" }).click();
  await expect(grid).toBeHidden();
  await expect.poll(() => linkTarget(join(app, ".agents/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
  expect(await linkTarget(join(app, ".agents/skills/lint"))).toBeNull();

  await window
    .getByTestId("sidebar")
    .getByRole("link", { name: /All Skills/ })
    .click();
  await window.getByTestId("library-skill").filter({ hasText: "lint" }).click();
  await window.getByRole("button", { name: "Add to Projects" }).click();
  const fromSkill = window.getByRole("dialog", { name: "Add to Projects" });
  await fromSkill.getByRole("checkbox", { name: "lint in app" }).check();
  await fromSkill.getByRole("button", { name: "Add 1 Link" }).click();
  await expect.poll(() => linkTarget(join(app, ".agents/skills/lint"))).toBe(join(libraryHome, "skills/local/lint"));
});
