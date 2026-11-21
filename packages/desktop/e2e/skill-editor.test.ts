import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

test("edit a Skill file and save with ⌘S, see it Modified, delete it into trash/, then Restore it", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  const global = join(home, ".agents", "skills", "find-skills");
  await mkdir(global, { recursive: true });
  await writeFile(join(global, "SKILL.md"), "---\nname: find-skills\ndescription: Find Skills\n---\n\n# Find\n");
  await writeFile(
    join(home, ".agents", ".skill-lock.json"),
    JSON.stringify({
      version: 3,
      skills: {
        "find-skills": {
          source: "vercel-labs/skills",
          sourceType: "github",
          sourceUrl: "https://github.com/vercel-labs/skills.git",
          skillPath: "skills/find-skills/SKILL.md",
          skillFolderHash: "",
          installedAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      },
    }),
  );
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

  await sidebar.getByTestId("sidebar-namespace").filter({ hasText: "vercel-labs/skills" }).click();
  await window.getByTestId("library-skill").click();
  await expect(window.getByTestId("modified-badge")).toHaveCount(0);

  // Files tab: type into SKILL.md, then ⌘S.
  await window.getByRole("tab", { name: "Files" }).click();
  const editor = window.getByTestId("code-editor").locator(".cm-content");
  await expect(editor).toContainText("# Find");
  await editor.click();
  await window.keyboard.press("ControlOrMeta+End");
  await window.keyboard.type("Edited here.\n");
  await expect(window.getByTestId("save-state")).toHaveText("Unsaved changes");
  await window.keyboard.press("ControlOrMeta+s");
  await expect(window.getByTestId("save-state")).toHaveText("Saved");

  const saved = join(libraryHome, "skills/vercel-labs/skills/find-skills/SKILL.md");
  await expect.poll(() => readFile(saved, "utf8")).toContain("# Find\nEdited here.\n");
  await expect(window.getByTestId("modified-badge")).toBeVisible();

  // Delete into trash/.
  await window.getByRole("button", { name: "Delete" }).click();
  const dialog = window.getByRole("dialog", { name: "Delete Skill" });
  await expect(dialog).toContainText("purged after 30 days");
  await dialog.getByRole("button", { name: "Move to trash" }).click();
  await expect.poll(() => exists(saved)).toBe(false);
  await expect.poll(async () => (await readdir(join(libraryHome, "trash")).catch(() => [])).length).toBe(1);

  // Restore from the Trash view (story 44).
  await sidebar.getByRole("link", { name: /Trash/ }).click();
  await window.getByTestId("trashed-skill").getByRole("button", { name: "Restore" }).click();
  await expect(window.getByTestId("trash-empty")).toBeVisible();
  await expect.poll(() => readFile(saved, "utf8")).toContain("Edited here.");
});
