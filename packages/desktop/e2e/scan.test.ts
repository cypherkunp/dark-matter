import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

test("Scan now lists a Global Skill in the Inbox, with a badge", async ({ launchApp, fixtureHome }) => {
  const skill = join(fixtureHome.home, ".claude", "skills", "pdf");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), '---\nname: pdf\ndescription: "Work with PDFs"\n---\n\nUse it.\n');
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByTestId("library-empty")).toBeVisible();

  await window.getByRole("button", { name: "Scan now" }).click();

  await expect(window.getByTestId("inbox-badge")).toHaveText("1");
  await expect(window.getByTestId("core-status")).toContainText("Scanned");
  await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();
  const group = window.getByTestId("inbox-group");
  await expect(group).toContainText("~/.claude/skills");
  await expect(group.getByTestId("inbox-finding")).toContainText("pdf");

  await group.getByRole("button", { name: "Ignore" }).click();
  await expect(window.getByTestId("inbox-empty")).toBeVisible();
  await expect(window.getByTestId("inbox-badge")).toBeHidden();

  await window.getByTestId("sidebar").getByRole("link", { name: "Agents" }).click();
  const claude = window.getByTestId("agent-card").filter({ hasText: "Claude Code" });
  await expect(claude).toContainText("Detected");
  await expect(claude).toContainText("~/.claude/skills");
});
