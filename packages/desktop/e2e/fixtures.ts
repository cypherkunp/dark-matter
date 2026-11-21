import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoreFile } from "@dark-matter/contracts";
import { _electron, test as base, type ElectronApplication, expect } from "@playwright/test";
import electronBinary from "electron";

const desktopDir = resolve(import.meta.dirname, "..");
const coreEntry = resolve(desktopDir, "../core/dist/main.mjs");

export interface FixtureHome {
  home: string;
  libraryHome: string;
  env: NodeJS.ProcessEnv;
  /** `core.json`, or null while no core has published one. */
  readCoreFile(): Promise<CoreFile | null>;
}

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const test = base.extend<{
  fixtureHome: FixtureHome;
  launchApp: () => Promise<ElectronApplication>;
  startHeadlessCore: () => Promise<ChildProcess>;
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures take their dependencies by destructuring.
  fixtureHome: async ({}, use) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dark-matter-e2e-")));
    const home = join(root, "home");
    const libraryHome = join(home, ".dark-matter");
    await mkdir(home);
    await use({
      home,
      libraryHome,
      env: { ...process.env, HOME: home, DARK_MATTER_HOME: libraryHome, DARK_MATTER_CORE_ENTRY: coreEntry },
      readCoreFile: async () => {
        try {
          return CoreFile.parse(JSON.parse(await readFile(join(libraryHome, "core.json"), "utf8")));
        } catch {
          return null;
        }
      },
    });
    await rm(root, { recursive: true, force: true });
  },

  launchApp: async ({ fixtureHome }, use) => {
    const apps: ElectronApplication[] = [];
    await use(async () => {
      const app = await _electron.launch({
        args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), desktopDir],
        env: fixtureHome.env as Record<string, string>,
      });
      apps.push(app);
      return app;
    });
    for (const app of apps) await app.close().catch(() => {});
  },

  /** A core with no app, as a CLI or MCP client would start it (ADR-0003). */
  startHeadlessCore: async ({ fixtureHome }, use) => {
    const cores: ChildProcess[] = [];
    await use(async () => {
      const core = spawn(electronBinary as unknown as string, [coreEntry], {
        env: { ...fixtureHome.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "inherit",
      });
      cores.push(core);
      await expect.poll(async () => (await fixtureHome.readCoreFile())?.pid).toBe(core.pid);
      return core;
    });
    for (const core of cores) core.kill("SIGKILL");
  },
});

export { expect };
