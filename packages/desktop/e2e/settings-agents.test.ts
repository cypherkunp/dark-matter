import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const savedPreferences = (libraryHome: string) =>
  readFile(join(libraryHome, "settings.json"), "utf8").then(
    (text) => JSON.parse(text).preferences,
    () => null,
  );

test("Settings › Agents shows the safe defaults and saves Adopt Permissions and the Guard", async ({
  launchApp,
  fixtureHome,
}) => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByTestId("library-empty")).toBeVisible();
  await window.getByRole("link", { name: "Settings" }).click();

  const section = window.getByTestId("agents-settings");
  await expect(section.getByRole("heading", { name: "Agents" })).toBeVisible();

  // Defaults (ADR-0007): .agents may move Skills and has no MCP switch; the others are off; the Guard is on.
  await expect(section.getByRole("switch", { name: "Allow moving Skills from .agents" })).toBeChecked();
  await expect(section.getByRole("switch", { name: "Allow moving MCP Servers from .agents" })).toHaveCount(0);
  for (const agent of ["Claude Code", "Cursor", "OpenCode", "Codex"]) {
    await expect(section.getByRole("switch", { name: `Allow moving Skills from ${agent}` })).not.toBeChecked();
    const mcp = section.getByRole("switch", { name: `Allow moving MCP Servers from ${agent}` });
    await expect(mcp).not.toBeChecked();
    await expect(mcp).toBeDisabled();
  }
  const guard = section.getByRole("switch", { name: "Never edit Agent config files" });
  await expect(guard).toBeChecked();
  await expect(section.getByTestId("agent-config-guard-reason")).toContainText("Never edit Agent config files");

  // An Adopt Permission saves straight away.
  await section.getByRole("switch", { name: "Allow moving Skills from Claude Code" }).click();
  await expect(section.getByRole("switch", { name: "Allow moving Skills from Claude Code" })).toBeChecked();
  await expect
    .poll(() => savedPreferences(fixtureHome.libraryHome))
    .toMatchObject({ adoptPermissions: { "claude-code": { skills: true, mcp: false } }, agentConfigGuard: true });

  // Turning the Guard off makes the MCP switches usable.
  await guard.click();
  await expect(guard).not.toBeChecked();
  await expect(section.getByTestId("agent-config-guard-reason")).toHaveCount(0);
  const codexMcp = section.getByRole("switch", { name: "Allow moving MCP Servers from Codex" });
  await expect(codexMcp).toBeEnabled();
  await codexMcp.click();
  await expect(codexMcp).toBeChecked();
  await expect
    .poll(() => savedPreferences(fixtureHome.libraryHome))
    .toMatchObject({ adoptPermissions: { codex: { skills: false, mcp: true } }, agentConfigGuard: false });

  // Turning it back on greys the MCP switches out again, keeping what they say.
  await guard.click();
  await expect(guard).toBeChecked();
  await expect(codexMcp).toBeDisabled();
  await expect(codexMcp).toBeChecked();
  await expect.poll(() => savedPreferences(fixtureHome.libraryHome)).toMatchObject({ agentConfigGuard: true });
});

test("saving the other preferences keeps the Adopt Permissions", async ({ launchApp, fixtureHome }) => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByTestId("library-empty")).toBeVisible();
  await window.getByRole("link", { name: "Settings" }).click();

  const section = window.getByTestId("agents-settings");
  await section.getByRole("switch", { name: "Allow moving Skills from Cursor" }).click();
  await expect
    .poll(() => savedPreferences(fixtureHome.libraryHome))
    .toMatchObject({ adoptPermissions: { cursor: { skills: true } } });

  await window.getByLabel("Scheduled Scan time").fill("07:30");
  await window.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() => savedPreferences(fixtureHome.libraryHome))
    .toMatchObject({ scheduledScanTime: "07:30", adoptPermissions: { cursor: { skills: true } } });
  await expect(section.getByRole("switch", { name: "Allow moving Skills from Cursor" })).toBeChecked();
});
