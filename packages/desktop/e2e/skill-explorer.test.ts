import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

test("a Skill opened from All Skills lands in the Explorer, with every file in the folder highlighted", async ({
  launchApp,
  fixtureHome,
}) => {
  const skill = join(fixtureHome.home, ".agents", "skills", "release");
  await mkdir(join(skill, "scripts"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: release\ndescription: Cut a release\n---\n\n# Release\n");
  await writeFile(join(skill, "scripts", "tag.sh"), '#!/bin/sh\necho "tagging $1"\n');

  const app = await launchApp();
  const window = await app.firstWindow();
  const sidebar = window.getByTestId("sidebar");

  await window.getByRole("button", { name: "Scan now" }).click();
  await sidebar.getByRole("link", { name: /Inbox/ }).click();
  await window.getByTestId("inbox-finding").getByRole("button", { name: "Adopt" }).click();
  await window
    .getByRole("dialog", { name: "Adopt 1 Skill" })
    .getByRole("button", { name: "Adopt", exact: true })
    .click();
  await expect(window.getByTestId("inbox-empty")).toBeVisible();

  await sidebar.getByRole("link", { name: /All Skills/ }).click();
  await window.getByTestId("library-skill").filter({ hasText: "release" }).click();

  // SKILL.md opens first, highlighted (tokens carry the theme's colours).
  await expect(window.getByRole("tab", { name: "Explorer" })).toHaveAttribute("aria-selected", "true");
  const viewer = window.getByTestId("explorer-viewer");
  await expect(window.getByTestId("explorer-path")).toHaveText("SKILL.md");
  await expect(viewer).toContainText("# Release");
  await expect(viewer.locator("[data-line] span[style]").first()).toBeVisible();

  // Any other file in the folder opens from the tree.
  await window
    .getByTestId("explorer-tree")
    .getByRole("treeitem", { name: /tag\.sh/ })
    .click();
  await expect(window.getByTestId("explorer-path")).toHaveText("scripts/tag.sh");
  await expect(viewer).toContainText('echo "tagging $1"');
});
