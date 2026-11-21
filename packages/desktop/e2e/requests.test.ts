import { execFileSync } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoreFile } from "@dark-matter/contracts";
import { createCoreClient } from "@dark-matter/contracts/client";
import { expect, test } from "./fixtures";

const isLink = (path: string) =>
  lstat(path).then(
    (info) => info.isSymbolicLink(),
    () => false,
  );

test("an Agent's Request waits in the Inbox, and Approve applies it and answers the waiting call", async ({
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
  await mkdir(app, { recursive: true });
  execFileSync("git", ["init", "--quiet", app]);
  await writeFile(join(libraryHome, "projects.json"), JSON.stringify({ projects: { [app]: { agents: ["codex"] } } }));

  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();
  await expect.poll(() => fixtureHome.readCoreFile()).not.toBeNull();
  const connection = (await fixtureHome.readCoreFile()) as CoreFile;
  // A fake Agent: not the app, over the same WebSocket (the future MCP shim, ADR-0006).
  const agent = createCoreClient({ connection, client: "mcp", agent: "claude-code" });
  try {
    // Once the window shows the Inbox, main is subscribed to notifications, so the call waits for a decision.
    await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();
    await expect(window.getByRole("heading", { name: "Inbox" })).toBeVisible();
    const call = agent.trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );

    const request = window.getByTestId("inbox-request");
    await expect(request).toContainText("Add local/pdf to app as a Link");
    await expect(request).toContainText("Claude Code asked");
    expect(await isLink(join(app, ".agents/skills/pdf"))).toBe(false);

    await request.getByRole("button", { name: "Approve" }).click();

    await expect(request).toHaveCount(0);
    await expect.poll(() => isLink(join(app, ".agents/skills/pdf"))).toBe(true);
    expect(await call).toEqual({
      result: [{ path: app, skills: [expect.objectContaining({ key: "local/pdf", on: true })] }],
    });
  } finally {
    await agent.close();
  }
});
