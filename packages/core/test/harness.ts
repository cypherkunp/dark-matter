import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CoreConnection, CoreFile } from "@dark-matter/contracts";
import { type CoreClient, type CoreClientOptions, createCoreClient } from "@dark-matter/contracts/client";
import { onTestFinished } from "vitest";
import {
  type Clock,
  type CoreEnv,
  type CoreNotification,
  type GitHubOptions,
  type RunningCore,
  type SecretStore,
  type SkillsShOptions,
  startCore,
} from "../src/index";

/** A throwaway `$HOME` for one test, removed when the test finishes. */
export const tempHome = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dark-matter-test-")));
  const home = join(root, "home");
  await mkdir(home);
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return { home, libraryHome: join(home, ".dark-matter") };
};

/** Boots a core in-process and stops it when the test finishes. */
export const bootCore = async (
  env: CoreEnv,
  fakes: {
    clock?: Clock;
    notifier?: { notify(notification: CoreNotification): void; available?(): boolean };
    secrets?: SecretStore;
    github?: GitHubOptions;
    requestWaitMs?: number;
    skillsSh?: SkillsShOptions;
  } = {},
): Promise<RunningCore> => {
  // Never the real keychain, GitHub or `gh` login in tests (an unroutable API unless a test passes the fake),
  // nor the machine's /etc and /Library.
  const github: GitHubOptions = { api: "http://127.0.0.1:9", ghToken: async () => null, ...fakes.github };
  const skillsSh: SkillsShOptions = { api: "http://127.0.0.1:9", ...fakes.skillsSh };
  const system = env.HOME ? { DARK_MATTER_SYSTEM_ROOT: join(dirname(env.HOME), "system") } : {};
  const core = await startCore({
    env: { DARK_MATTER_SECRETS: "memory", ...system, ...env },
    ...fakes,
    github,
    skillsSh,
  });
  onTestFinished(() => core.stop());
  return core;
};

/** A real contracts client, closed when the test finishes. */
export const connect = (connection: CoreConnection, hooks: Pick<CoreClientOptions, "onClose"> = {}): CoreClient => {
  const client = createCoreClient({ connection, client: "app", ...hooks });
  onTestFinished(() => client.close());
  return client;
};

/**
 * A client that isn't the app, like the future MCP shim (ADR-0006): it connects
 * over the same WebSocket and says who it is.
 */
export const connectAgent = (connection: CoreConnection, agent = "claude-code"): CoreClient => {
  const client = createCoreClient({ connection, client: "mcp", agent });
  onTestFinished(() => client.close());
  return client;
};

export const readCoreFile = async (libraryHome: string) =>
  CoreFile.parse(JSON.parse(await readFile(join(libraryHome, "core.json"), "utf8")));

/**
 * A controllable clock. Time stands still until `set()`, which moves it and
 * fires every timer once, like a computer waking up or a minute passing.
 */
export const fakeClock = (start: Date) => {
  let now = start;
  const timers = new Set<() => void>();
  const clock: Clock & { set(to: Date): void } = {
    now: () => new Date(now),
    every: (_ms, tick) => {
      timers.add(tick);
      return () => timers.delete(tick);
    },
    set: (to) => {
      now = to;
      for (const tick of timers) tick();
    },
  };
  return clock;
};

/** Records the notifications the core sends instead of showing them. */
export const fakeNotifier = () => {
  const sent: CoreNotification[] = [];
  return { sent, notify: (notification: CoreNotification) => void sent.push(notification) };
};

/** A local wall-clock time on 2026-11-`day`. */
export const localTime = (day: number, hours: number, minutes = 0) => new Date(2026, 10, day, hours, minutes);
