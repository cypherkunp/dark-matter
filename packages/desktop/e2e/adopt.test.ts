import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

test("Adopt moves one Global Skill into the Library after a dry-run plan", async ({ launchApp, fixtureHome }) => {
  const skill = join(fixtureHome.home, ".claude", "skills", "pdf");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), '---\nname: pdf\ndescription: "Work with PDFs"\n---\n\nUse it.\n');
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByRole("button", { name: "Scan now" }).click();
  await expect(window.getByTestId("inbox-badge")).toHaveText("1");
  await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();

  await window.getByTestId("inbox-finding").getByRole("button", { name: "Adopt" }).click();

  const plan = window.getByRole("dialog", { name: "Adopt 1 Skill" });
  await expect(plan).toContainText("stops being visible to every Agent everywhere");
  await expect(plan).toContainText("~/.claude/skills/pdf");
  await expect(plan).toContainText("~/.dark-matter/skills/local/pdf");
  await plan.getByRole("button", { name: "Adopt", exact: true }).click();

  await expect(window.getByTestId("inbox-empty")).toBeVisible();
  await expect(window.getByTestId("inbox-badge")).toBeHidden();
  await window
    .getByTestId("sidebar")
    .getByRole("link", { name: /All Skills/ })
    .click();
  const namespace = window.getByTestId("library-namespace").filter({ hasText: "local" });
  await expect(namespace.getByTestId("library-skill")).toContainText("pdf");
  await expect(namespace.getByTestId("library-skill")).toContainText("Work with PDFs");
  await expect
    .poll(() =>
      lstat(join(skill, "SKILL.md")).then(
        () => true,
        () => false,
      ),
    )
    .toBe(false);
});
