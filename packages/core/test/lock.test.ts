import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CoreLocked } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { startCore } from "../src/index";
import { bootCore, connect, readCoreFile, tempHome } from "./harness";

describe("core.lock: one writer per Library", () => {
  test("refuses a second core while the first holds the lock", async () => {
    const { home, libraryHome } = await tempHome();
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    const first = await bootCore(env);

    const second = startCore({ env });
    await expect(second).rejects.toBeInstanceOf(CoreLocked);
    await expect(second).rejects.toMatchObject({ holderPid: process.pid });

    // The running core and its core.json are untouched.
    const coreFile = await readCoreFile(libraryHome);
    expect(coreFile.token).toBe(first.token);
    await expect(connect(coreFile).trpc.core.info.query()).resolves.toMatchObject({
      home: libraryHome,
    });
  });

  test("lets a new core start once the first has stopped", async () => {
    const { home, libraryHome } = await tempHome();
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    const first = await bootCore(env);
    await first.stop();

    const second = await bootCore(env);
    expect((await readCoreFile(libraryHome)).token).toBe(second.token);
  });

  test("takes over a lock left by a core that is no longer running", async () => {
    const { home, libraryHome } = await tempHome();
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    const first = await bootCore(env);
    await first.stop();
    // A crashed core leaves its lock behind. No live process has this pid.
    await writeFile(join(libraryHome, "core.lock"), JSON.stringify({ pid: 2 ** 22 + 1 }));

    const second = await bootCore(env);
    expect((await readCoreFile(libraryHome)).token).toBe(second.token);
  });
});
