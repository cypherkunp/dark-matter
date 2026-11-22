import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allowAdoptEverywhere, expect, test } from "./fixtures";

// Tests Adopt and the off switches themselves; their gating (ADR-0007) is in inbox-consent and first-run.
test.use({ preferences: allowAdoptEverywhere });

test("Agent-managed Skills are listed in the Inbox and turned off through the Agent's settings", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home } = fixtureHome;
  const skill = join(home, ".codex/skills/.system/skill-creator");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: skill-creator\n---\n\nMake Skills.\n");
  const builtIn = join(home, ".cursor/skills-cursor/create-rule");
  await mkdir(builtIn, { recursive: true });
  await writeFile(join(builtIn, "SKILL.md"), "---\nname: create-rule\n---\n\nMake rules.\n");
  await writeFile(join(home, ".codex/config.toml"), '# mine\nmodel = "gpt-5.5"\n');
  const app = await launchApp();
  const window = await app.firstWindow();

  await window.getByRole("button", { name: "Scan now" }).click();
  await expect(window.getByTestId("inbox-badge")).toHaveText("2");
  await window.getByTestId("sidebar").getByRole("link", { name: /Inbox/ }).click();
  const cursor = window.getByTestId("inbox-managed-finding").filter({ hasText: "create-rule" });
  await expect(cursor).toContainText("Cursor has no off switch");
  await expect(cursor.getByRole("button", { name: /Turn off/ })).toHaveCount(0);

  const codex = window.getByTestId("inbox-managed-finding").filter({ hasText: "skill-creator" });
  await codex.getByRole("button", { name: "Turn off everywhere" }).click();

  await expect(codex).toBeHidden();
  await expect(window.getByTestId("inbox-badge")).toHaveText("1");
  expect(await readFile(join(home, ".codex/config.toml"), "utf8")).toContain(
    '# mine\nmodel = "gpt-5.5"\n\n[[skills.config]]\npath = ',
  );
  await window.getByTestId("sidebar").getByRole("link", { name: "Agents" }).click();
  const codexCard = window.getByTestId("agent-card").filter({ hasText: "Codex" });
  await expect(codexCard.getByTestId("agent-managed-count")).toHaveText("1");
});
