import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startFakeGitHub } from "./fake-github";
import { expect, test } from "./fixtures";

test("Check upstream finds an update, and the Updates list applies it with a diff", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  const github = await startFakeGitHub(join(home, "..", "github"), "acme/skills", {
    "skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Work with PDFs\n---\n# PDF tools\n",
  });
  fixtureHome.env.DARK_MATTER_GITHUB_API = github.api;
  try {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.getByTestId("sidebar").getByRole("link", { name: "GitHub import" }).click();
    await window.getByRole("textbox", { name: "GitHub Source" }).fill("acme/skills");
    await window.getByRole("button", { name: "Find Skills" }).click();
    await window.getByRole("button", { name: "Import 1 Skill" }).click();
    await expect(window.getByTestId("import-result")).toContainText("acme/skills/pdf");
    await window.keyboard.press("Escape");

    await github.commit({
      "skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Work with PDFs\n---\n# PDF tools v2\n",
    });
    await window.getByTestId("sidebar").getByRole("link", { name: "All Skills" }).click();
    await window.getByTestId("library-skill").filter({ hasText: "pdf" }).click();
    await window.getByRole("button", { name: "Check upstream" }).click();
    await expect(window.getByTestId("check-upstream-result")).toHaveText("Update available");

    await window.getByRole("link", { name: "Update available" }).click();
    const row = window.getByTestId("update-row");
    await expect(row).toContainText("acme/skills/pdf");
    await row.getByRole("button", { name: "Diff" }).click();
    await expect(row.getByTestId("update-diff")).toContainText("+# PDF tools v2");
    await row.getByRole("button", { name: "Update", exact: true }).click();
    await expect(window.getByTestId("updates-empty")).toBeVisible();
    expect(await readFile(join(libraryHome, "skills/acme/skills/pdf/SKILL.md"), "utf8")).toContain("PDF tools v2");
  } finally {
    await github.close();
  }
});
