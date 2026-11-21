import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CoreConnection, CoreFile } from "@dark-matter/contracts";
import { type CoreClient, type CoreClientOptions, createCoreClient } from "@dark-matter/contracts/client";
import { onTestFinished } from "vitest";
import { type Clock, type CoreEnv, type CoreNotification, type RunningCore, startCore } from "../src/index";

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
  fakes: { clock?: Clock; notifier?: { notify(notification: CoreNotification): void } } = {},
): Promise<RunningCore> => {
  const core = await startCore({ env, ...fakes });
  onTestFinished(() => core.stop());
  return core;
};

/** A real contracts client, closed when the test finishes. */
export const connect = (connection: CoreConnection, hooks: Pick<CoreClientOptions, "onClose"> = {}): CoreClient => {
  const client = createCoreClient({ connection, client: "app", ...hooks });
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
