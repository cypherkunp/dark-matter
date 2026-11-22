import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoreFile } from "@dark-matter/contracts";
import { _electron, test as base, type ElectronApplication, expect } from "@playwright/test";
import electronBinary from "electron";

/** This process's env without the Agents' own location overrides, so a test never finds the developer's real config. */
const agentFreeEnv = () => {
  const { CLAUDE_CONFIG_DIR: _claude, CODEX_HOME: _codex, XDG_CONFIG_HOME: _xdg, ...rest } = process.env;
  return rest;
};

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
  /**
   * Whether the First run (#46) is already done in the fixture home, so the app
   * opens on the Library. `test.use({ firstRunDone: false })` to walk it.
   */
  firstRunDone: boolean;
  /**
   * Preferences seeded into `settings.json` before launch, e.g. to opt in to
   * Adopt (ADR-0007): `test.use({ preferences: allowAdoptEverywhere })`.
   */
  preferences: Record<string, unknown> | null;
  fixtureHome: FixtureHome;
  launchApp: () => Promise<ElectronApplication>;
  startHeadlessCore: () => Promise<ChildProcess>;
}>({
  firstRunDone: [true, { option: true }],
  preferences: [null, { option: true }],

  fixtureHome: async ({ firstRunDone, preferences }, use) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dark-matter-e2e-")));
    const home = join(root, "home");
    const libraryHome = join(home, ".dark-matter");
    await mkdir(home);
    if (firstRunDone || preferences) {
      await mkdir(libraryHome);
      await writeFile(
        join(libraryHome, "settings.json"),
        JSON.stringify({
          ...(firstRunDone ? { firstRun: { completedAt: "2026-11-01T00:00:00.000Z" } } : {}),
          ...(preferences ? { preferences } : {}),
        }),
      );
    }
    await use({
      home,
      libraryHome,
      env: {
        ...agentFreeEnv(),
        HOME: home,
        DARK_MATTER_HOME: libraryHome,
        DARK_MATTER_CORE_ENTRY: coreEntry,
        // Never the real keychain in e2e tests.
        DARK_MATTER_SECRETS: "memory",
        // Nor the machine's /etc and /Library.
        DARK_MATTER_SYSTEM_ROOT: join(root, "system"),
        // Nor the real skills.sh (a test that searches passes its fake).
        DARK_MATTER_SKILLS_SH_API: "http://127.0.0.1:9",
      },
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

/**
 * Every Adopt Permission on and the Agent Config Guard off (ADR-0007), for
 * tests of Adopt and Agent-managed off switches themselves rather than of
 * their gating (first-run, inbox-consent and settings-agents cover that).
 */
export const allowAdoptEverywhere = {
  agentConfigGuard: false,
  adoptPermissions: Object.fromEntries(
    ["claude-code", "cursor", "opencode", "codex", "agents"].map((agent) => [agent, { skills: true, mcp: true }]),
  ),
};

export { expect };
