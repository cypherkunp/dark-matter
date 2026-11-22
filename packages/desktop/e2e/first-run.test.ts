import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "./fixtures";

test.use({ firstRunDone: false });

const write = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

const skill = (dir: string, name: string, description: string) =>
  write(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: "${description}"\n---\n\nUse it.\n`);

const kind = (path: string) =>
  lstat(path).then(
    (info) => (info.isSymbolicLink() ? "link" : info.isDirectory() ? "folder" : "file"),
    () => null,
  );

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });

/**
 * A computer that has used Claude Code for a while: a Global Skill, a plugin's
 * Skill, a global MCP Server, and two repos it worked in, one with a committed
 * (Vendored) Skill and an untracked one.
 */
const seedComputer = async (home: string) => {
  await skill(join(home, ".claude/skills/pdf"), "pdf", "Work with PDFs");
  const plugin = join(home, ".claude/plugins/cache/acme/review-kit/1.0.0");
  await skill(join(plugin, "skills/review"), "review", "Review code");
  await write(
    join(home, ".claude/plugins/installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "review-kit@acme": [
          { scope: "user", installPath: plugin, version: "1.0.0", installedAt: "2026-11-01T00:00:00Z" },
        ],
      },
    }),
  );
  const app = join(home, "code/app");
  const api = join(home, "code/api");
  for (const repo of [app, api]) {
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "--quiet", repo]);
  }
  await skill(join(app, ".claude/skills/team"), "team", "Team rules");
  git(app, "add", ".claude/skills/team");
  git(app, "commit", "--quiet", "-m", "vendor team");
  await skill(join(app, ".agents/skills/notes"), "notes", "Take notes");
  await write(
    join(home, ".claude.json"),
    JSON.stringify({
      projects: { [app]: {}, [api]: {} },
      mcpServers: { "github-tools": { type: "stdio", command: "npx", args: ["github-tools"] } },
    }),
  );
  return { app, api };
};

test("the First run Scans on consent, Adopts every Global Skill once, confirms Projects and sets one up", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  const { app } = await seedComputer(home);
  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();

  // 1. Welcome: nothing is read until you agree.
  await expect(window.getByRole("heading", { name: "Skills belong to Projects" })).toBeVisible();
  await expect(window.getByTestId("sidebar")).toBeHidden();
  expect(await kind(join(libraryHome, "settings.json"))).toBeNull();
  await window.getByRole("button", { name: "Scan my computer" }).click();

  // 2. What was found: the shared Inventory (its own test below).
  await expect(window.getByRole("heading", { name: "What the Scan found" })).toBeVisible();
  await expect(window.getByTestId("inventory")).toContainText("pdf");
  await window.getByRole("button", { name: "Continue" }).click();

  // 3. One confirmation for every Global Skill, with the dry-run plan and the warning.
  const confirm = window.getByTestId("first-run-adopt");
  await expect(confirm).toContainText("stops being visible to every Agent everywhere");
  await expect(confirm).toContainText("~/.claude/skills/pdf");
  await expect(confirm).toContainText("~/.dark-matter/skills/local/pdf");
  await window.getByRole("button", { name: "Adopt 1 Global Skill" }).click();

  // 4. Summary.
  await expect(window.getByTestId("first-run-summary")).toContainText("1 moved into the Library");
  expect(await kind(join(home, ".claude/skills/pdf"))).toBeNull();
  expect(await kind(join(libraryHome, "skills/local/pdf"))).toBe("folder");
  await window.getByRole("button", { name: "Continue" }).click();

  // 5. Confirm Suggested Projects: only app; api stays Suggested.
  await expect(window.getByRole("heading", { name: "Confirm your Projects" })).toBeVisible();
  await window.getByTestId("first-run-project").filter({ hasText: "api" }).getByRole("checkbox").click();
  await window.getByRole("button", { name: "Confirm 1 Project" }).click();

  // 6. Set up app: pick Skills, Link or Copy explained.
  await expect(window.getByRole("heading", { name: "Set up app" })).toBeVisible();
  await expect(window.getByTestId("first-run-modes")).toContainText("excluded from git");
  await expect(window.getByTestId("first-run-modes")).toContainText("committed");
  await window.getByRole("button", { name: "Pick Skills" }).click();
  const grid = window.getByTestId("add-to-projects-grid");
  await grid.getByRole("button", { name: "app" }).click();
  await window.getByRole("button", { name: "Add 1 Link" }).click();
  await expect.poll(() => kind(join(app, ".claude/skills/pdf"))).toBe("link");
  await window.getByRole("button", { name: "Finish" }).click();

  // 7. Start at login, checked by default; then the Library.
  await expect(window.getByRole("checkbox", { name: "Start at login" })).toBeChecked();
  await window.getByRole("button", { name: "Open the Library" }).click();
  await expect(window.getByRole("heading", { name: "All Skills" })).toBeVisible();
  await expect(window.getByTestId("sidebar")).toBeVisible();
  await expect(window.getByTestId("suggested-badge")).toHaveText("1");
  await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();
  await expect(window.getByTestId("inbox-untracked-finding")).toContainText("notes");
  await expect(window.getByText("github-tools", { exact: true })).toBeVisible();
  await expect
    .poll(() => readFile(join(libraryHome, "settings.json"), "utf8").then(JSON.parse, () => null))
    .toMatchObject({ firstRun: { completedAt: expect.any(String) }, preferences: { startAtLogin: true } });

  // It runs once: the next launch opens on the Library.
  await electronApp.close();
  const again = await (await launchApp()).firstWindow();
  await expect(again.getByRole("heading", { name: "All Skills" })).toBeVisible();
  await expect(again.getByRole("heading", { name: "Skills belong to Projects" })).toBeHidden();
});

test("the Found step lists everything by owning folder, .agents first, with who sees it and why it's read-only", async ({
  launchApp,
  fixtureHome,
}) => {
  await seedComputer(fixtureHome.home);
  const window = await (await launchApp()).firstWindow();

  await window.getByRole("button", { name: "Scan my computer" }).click();

  await expect(window.getByRole("heading", { name: "What the Scan found" })).toBeVisible();
  const groups = window.getByTestId("inventory-group");
  await expect(groups).toHaveCount(5);
  expect(await groups.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-folder")))).toEqual([
    "app/.agents/skills",
    "~/.claude.json",
    "~/.claude/skills",
    "app/.claude/skills",
    "~/.claude",
  ]);
  const item = (name: string) => window.getByTestId("inventory-item").filter({ hasText: name });
  // The Project's .agents/skills can always be adopted, and every Agent but Claude Code reads it.
  await expect(item("notes")).toContainText("Untracked Skill");
  await expect(item("notes").getByTestId("inventory-agents")).toHaveText("Seen by Cursor, OpenCode, Codex, .agents");
  await expect(item("notes").getByTestId("inventory-read-only")).toBeHidden();
  // Everything else is read-only here, with the reason.
  await expect(item("pdf").getByTestId("inventory-agents")).toHaveText("Seen by Claude Code, Cursor, OpenCode");
  await expect(item("pdf").getByTestId("inventory-reason")).toContainText("Claude Code's Adopt Permission is off");
  await expect(item("github-tools")).toContainText("Global MCP Server");
  await expect(item("github-tools").getByTestId("inventory-reason")).toContainText("Agent Config Guard is on");
  await expect(item("team")).toContainText("Vendored Skill");
  await expect(item("team").getByTestId("inventory-reason")).toContainText("Committed in the repo");
  await expect(item("review")).toContainText("Agent-managed Skill");
  await expect(item("review").getByTestId("inventory-reason")).toContainText("Claude Code installs and controls it");
});

test("declining the Adopt and skipping the rest leaves everything in the Inbox and Suggested", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home } = fixtureHome;
  await seedComputer(home);
  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();

  await window.getByRole("button", { name: "Scan my computer" }).click();
  await window.getByRole("button", { name: "Continue" }).click();
  await window.getByRole("button", { name: "Keep them in the Inbox" }).click();
  await expect(window.getByRole("heading", { name: "Confirm your Projects" })).toBeVisible();
  await window.getByRole("button", { name: "Skip the rest" }).click();
  await window.getByRole("checkbox", { name: "Start at login" }).click();
  await window.getByRole("button", { name: "Open the Library" }).click();

  await expect(window.getByRole("heading", { name: "All Skills" })).toBeVisible();
  expect(await kind(join(home, ".claude/skills/pdf"))).toBe("folder");
  await expect(window.getByTestId("suggested-badge")).toHaveText("2");
  await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();
  await expect(window.getByTestId("inbox-finding")).toContainText("pdf");
  await expect
    .poll(() => readFile(join(fixtureHome.libraryHome, "settings.json"), "utf8").then(JSON.parse, () => null))
    .toMatchObject({ firstRun: { completedAt: expect.any(String) }, preferences: { startAtLogin: false } });
});
