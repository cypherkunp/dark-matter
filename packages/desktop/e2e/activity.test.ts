import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivityEntry } from "@dark-matter/contracts";
import { expect, test } from "./fixtures";

test("filters, searches and expands the Activity timeline, and links to a Project's own Activity", async ({
  launchApp,
  fixtureHome,
}) => {
  const site = join(fixtureHome.home, "code", "site");
  await mkdir(site, { recursive: true });
  await mkdir(join(fixtureHome.libraryHome, "activity"), { recursive: true });
  await writeFile(
    join(fixtureHome.libraryHome, "projects.json"),
    JSON.stringify({ projects: { [site]: { agents: ["claude-code"] } } }),
  );
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const entries: ActivityEntry[] = [
    {
      id: "add",
      time: at(30),
      client: "app",
      action: "project.add",
      subjects: [{ kind: "project", id: site }],
      result: "ok",
      filesWritten: ["~/.dark-matter/projects.json"],
    },
    {
      id: "conflict",
      time: at(20),
      client: "cli",
      action: "project.addSkills",
      subjects: [
        { kind: "project", id: site },
        { kind: "skill", id: "local/docx" },
      ],
      result: "error",
      error: { tag: "NameConflict", message: "Two Project Skills are both delivered as docx" },
      filesWritten: [],
    },
    {
      id: "ignore",
      time: at(10),
      client: "app",
      action: "inbox.ignore",
      subjects: [{ kind: "finding", id: "global-skill:~/.claude/skills/pdf" }],
      result: "ok",
      filesWritten: ["~/.dark-matter/settings.json"],
    },
  ];
  // One file per UTC day, as the core writes them.
  for (const entry of entries) {
    await writeFile(
      join(fixtureHome.libraryHome, "activity", `${entry.time.slice(0, 10)}.jsonl`),
      `${JSON.stringify(entry)}\n`,
      { flag: "a" },
    );
  }

  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByTestId("sidebar").getByRole("link", { name: "Activity" }).click();
  const rows = window.getByTestId("activity-entry");
  await expect(rows).toHaveCount(3);

  await window.getByLabel("Failures only").check();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Added Project Skills");
  await rows.first().getByRole("button", { name: "Show details" }).click();
  await expect(rows.first().getByTestId("activity-error")).toContainText("NameConflict");
  await expect(rows.first().getByTestId("activity-error")).toContainText("both delivered as docx");

  await window.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows).toHaveCount(3);
  await window.getByLabel("Search Activity").fill("projects.json");
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole("button", { name: "Show details" }).click();
  await expect(rows.first().getByTestId("activity-files")).toHaveText("~/.dark-matter/projects.json");

  await rows.first().getByTestId("activity-subject").click();
  await expect(window.getByRole("heading", { name: "site" })).toBeVisible();
  const projectActivity = window.getByTestId("filtered-activity");
  await expect(projectActivity.getByTestId("activity-entry")).toHaveCount(2);
  await expect(projectActivity).not.toContainText("Ignored a finding");
});
