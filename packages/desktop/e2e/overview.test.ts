import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

test("the Library overview shows stat cards and an alert that opens the Inbox; an Ignore can be restored", async ({
  launchApp,
  fixtureHome,
}) => {
  const skill = join(fixtureHome.home, ".claude", "skills", "pdf");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), '---\nname: pdf\ndescription: "Work with PDFs"\n---\n\nUse it.\n');
  const app = await launchApp();
  const window = await app.firstWindow();
  const globalSkills = window.getByTestId("stat-card").filter({ hasText: "Global Skills found" });
  await expect(globalSkills.getByTestId("stat-count")).toHaveText("–");

  await window.getByRole("button", { name: "Scan now" }).click();

  await expect(globalSkills.getByTestId("stat-count")).toHaveText("1");
  const alert = window.getByTestId("overview-alert");
  await expect(alert).toContainText("~/.claude/skills 1 Global Skill found");
  await expect(alert).toContainText("First observed just now");

  await alert.click();
  const finding = window.getByTestId("inbox-finding");
  await finding.getByRole("button", { name: "Ignore" }).click();
  await window.getByRole("button", { name: "Show ignored" }).click();
  await window.getByTestId("ignored-finding").getByRole("button", { name: "Restore" }).click();
  await expect(finding).toContainText("pdf");
  await expect(window.getByTestId("inbox-badge")).toHaveText("1");
});
