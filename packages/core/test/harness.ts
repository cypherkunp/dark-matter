import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CoreConnection, CoreFile } from "@dark-matter/contracts";
import { type CoreClient, type CoreClientOptions, createCoreClient } from "@dark-matter/contracts/client";
import { onTestFinished } from "vitest";
import { type CoreEnv, type RunningCore, startCore } from "../src/index";

/** A throwaway `$HOME` for one test, removed when the test finishes. */
export const tempHome = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dark-matter-test-")));
  const home = join(root, "home");
  await mkdir(home);
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return { home, libraryHome: join(home, ".dark-matter") };
};

/** Boots a core in-process and stops it when the test finishes. */
export const bootCore = async (env: CoreEnv): Promise<RunningCore> => {
  const core = await startCore({ env });
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
