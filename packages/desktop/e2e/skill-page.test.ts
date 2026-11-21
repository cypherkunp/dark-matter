import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

test("Skill page, ⌘K and Rename Namespace, then Undo Adopt from Provenance", async ({ launchApp, fixtureHome }) => {
  const skill = join(fixtureHome.home, ".claude", "skills", "pdf");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: pdf\n---\n\n# Working with PDFs\n\n- split\n- merge\n");
  const app = await launchApp();
  const window = await app.firstWindow();
  const sidebar = window.getByTestId("sidebar");

  // Adopt it from the Inbox.
  await window.getByRole("button", { name: "Scan now" }).click();
  await expect(window.getByTestId("inbox-badge")).toHaveText("1");
  await sidebar.getByRole("link", { name: /Inbox/ }).click();
  await window.getByTestId("inbox-finding").getByRole("button", { name: "Adopt" }).click();
  await window
    .getByRole("dialog", { name: "Adopt 1 Skill" })
    .getByRole("button", { name: "Adopt", exact: true })
    .click();
  await expect(window.getByTestId("inbox-empty")).toBeVisible();

  // ⌘K jumps to the Skill.
  await window.keyboard.press("ControlOrMeta+k");
  const palette = window.getByTestId("command-palette");
  await palette.getByRole("combobox").fill("pdf");
  await palette.getByRole("combobox").press("Enter");
  await expect(window.getByRole("navigation", { name: "Breadcrumb" })).toHaveText(/Library.*local.*pdf/);
  await expect(window.getByRole("heading", { name: "Working with PDFs" })).toBeVisible();
  await expect(window.getByTestId("frontmatter-warnings")).toContainText("description is missing");
  await expect(window.getByTestId("skill-provenance-line")).toContainText("local");

  // Rename its Namespace from the Namespace view.
  await sidebar.getByTestId("sidebar-namespace").filter({ hasText: "local" }).click();
  await window.getByRole("button", { name: "Rename Namespace" }).click();
  const rename = window.getByRole("dialog", { name: "Rename Namespace" });
  await rename.getByLabel("New Namespace").fill("acme/tools");
  await expect(rename).toContainText("~/.dark-matter/skills/acme/tools/pdf");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(window.getByRole("navigation", { name: "Breadcrumb" })).toHaveText(/Library.*acme\/tools/);
  await expect(sidebar.getByTestId("sidebar-namespace")).toHaveText(/acme\/tools/);
  await expect.poll(() => exists(join(fixtureHome.libraryHome, "skills/acme/tools/pdf/SKILL.md"))).toBe(true);

  // Undo Adopt lives in the Provenance tab now.
  await window.getByTestId("library-skill").click();
  await window.getByRole("tab", { name: "Provenance" }).click();
  await expect(window.getByTestId("adopted-from")).toHaveText("~/.claude/skills/pdf");
  await window.getByRole("button", { name: "Undo Adopt" }).click();
  await window.getByRole("dialog").getByRole("button", { name: "Undo Adopt" }).click();
  await expect(window.getByTestId("library-empty")).toBeVisible();
  await expect.poll(() => exists(join(skill, "SKILL.md"))).toBe(true);
});
