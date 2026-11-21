import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { _electron } from "@playwright/test";
import { expect, isAlive, test } from "./fixtures";

// Drives an electron-builder output (`pnpm package --dir`), not the dev build.
// Set DARK_MATTER_PACKAGED_APP to the packaged executable, e.g.
// `release/mac-arm64/Dark Matter.app/Contents/MacOS/Dark Matter`.
const executablePath = process.env.DARK_MATTER_PACKAGED_APP;

test("the packaged app starts its bundled core and shows the Library", async ({ fixtureHome }) => {
  test.skip(!executablePath, "DARK_MATTER_PACKAGED_APP is not set");
  if (!executablePath) return;
  const { DARK_MATTER_CORE_ENTRY: _, ...env } = fixtureHome.env;
  const app = await _electron.launch({
    executablePath,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
    env: env as Record<string, string>,
  });
  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId("library-empty")).toBeVisible();

    const { mainPid, resourcesPath, packaged } = await app.evaluate(({ app }) => ({
      mainPid: process.pid,
      resourcesPath: process.resourcesPath,
      packaged: app.isPackaged,
    }));
    expect(packaged).toBe(true);

    const coreFile = await fixtureHome.readCoreFile();
    if (!coreFile) throw new Error("no core.json after launch");
    expect(coreFile.pid).not.toBe(mainPid);
    // The core is the app's own binary running the extra resource.
    const command = execFileSync("ps", ["-o", "command=", "-p", String(coreFile.pid)], { encoding: "utf8" });
    expect(command).toContain(join(resourcesPath, "core", "main.mjs"));

    await app.close();
    await expect.poll(() => fixtureHome.readCoreFile()).toBeNull();
    expect(isAlive(coreFile.pid)).toBe(false);
  } finally {
    await app.close().catch(() => {});
  }
});
