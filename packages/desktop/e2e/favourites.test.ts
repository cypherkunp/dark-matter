import { join } from "node:path";
import { startFakeGitHub } from "./fake-github";
import { expect, test } from "./fixtures";

test("star a Source at Import and a Skill on its row; new Skills and updates show in the sidebar", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home } = fixtureHome;
  const github = await startFakeGitHub(join(home, "..", "github"), "acme/skills", {
    "skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Work with PDFs\n---\n# PDF tools\n",
  });
  fixtureHome.env.DARK_MATTER_GITHUB_API = github.api;
  try {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    const sidebar = window.getByTestId("sidebar");
    await sidebar.getByRole("link", { name: "GitHub import" }).click();
    await window.getByRole("textbox", { name: "GitHub Source" }).fill("acme/skills");
    await window.getByRole("button", { name: "Find Skills" }).click();
    await window.getByRole("button", { name: "Favourite this Source" }).click();
    await expect(window.getByTestId("star-source")).toHaveAttribute("aria-pressed", "true");
    await window.getByRole("button", { name: "Import 1 Skill" }).click();
    await expect(window.getByTestId("import-result")).toContainText("acme/skills/pdf");
    await window.keyboard.press("Escape");

    await sidebar.getByRole("link", { name: "Favourites" }).click();
    await expect(window.getByTestId("favourite-source-row")).toContainText("acme/skills");
    await expect(window.getByTestId("library-skill")).toContainText("pdf");

    // The first check learns the Source; the next one finds what it gained.
    await sidebar.getByRole("link", { name: "Updates" }).click();
    await window.getByRole("button", { name: "Check for updates" }).click();
    await expect(window.getByText("Not checked yet")).toHaveCount(0);
    await github.commit({
      "skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Work with PDFs\n---\n# PDF tools v2\n",
      "skills/docx/SKILL.md": "---\nname: docx\ndescription: Word files\n---\n",
    });
    await window.getByRole("button", { name: "Check for updates" }).click();
    await expect(sidebar.getByTestId("updates-badge")).toHaveText("1");

    await sidebar.getByRole("link", { name: "Inbox" }).click();
    const group = window.getByTestId("inbox-new-skills");
    await expect(group).toContainText("New Skills in ⭐ acme/skills");
    await expect(group.getByTestId("inbox-new-skill")).toContainText("docx");
    await group.getByRole("button", { name: "Ignore" }).click();
    await expect(group).toHaveCount(0);

    await sidebar.getByRole("link", { name: "All Skills" }).click();
    await window.getByTestId("library-skill").filter({ hasText: "pdf" }).waitFor();
    await window.getByRole("button", { name: "Star Skill" }).click();
    await expect(window.getByRole("button", { name: "Unstar Skill" })).toBeVisible();
  } finally {
    await github.close();
  }
});
