import { execFileSync } from "node:child_process";
import { lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const linkTarget = (path: string) =>
  lstat(path).then(
    () => readlink(path),
    () => null,
  );

test("deleting a Link on disk shows drift in the Inbox live, and Restore puts it back", async ({
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
  await mkdir(join(app, ".agents/skills"), { recursive: true });
  execFileSync("git", ["init", "--quiet", app]);
  const link = join(app, ".agents/skills/pdf");
  await symlink(skill, link, "dir");
  await writeFile(
    join(libraryHome, "projects.json"),
    JSON.stringify({ projects: { [app]: { agents: ["codex"], skills: { "local/pdf": { mode: "link", on: true } } } } }),
  );

  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();
  await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();
  await expect(window.getByTestId("inbox-empty")).toBeVisible();

  await rm(link);

  const finding = window.getByTestId("inbox-drift-finding");
  await expect(finding).toContainText("Link deleted on disk");
  await finding.getByRole("button", { name: "Restore" }).click();
  await expect(finding).toHaveCount(0);
  await expect.poll(() => linkTarget(link)).toBe(skill);
});
