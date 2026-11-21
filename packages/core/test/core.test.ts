import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bootCore, connect, readCoreFile, tempHome } from "./harness";

describe("booting the core", () => {
  test("publishes core.json and answers through the contracts client", async () => {
    const { home, libraryHome } = await tempHome();
    await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });

    const coreFile = await readCoreFile(libraryHome);
    expect(coreFile.pid).toBe(process.pid);
    expect((await stat(join(libraryHome, "core.json"))).mode & 0o777).toBe(0o600);

    const { trpc } = connect(coreFile);
    const info = await trpc.core.info.query();
    expect(info.home).toBe(libraryHome);
    expect(info.pid).toBe(process.pid);
  });

  test("uses $HOME/.dark-matter when DARK_MATTER_HOME is not set", async () => {
    const { home } = await tempHome();
    await bootCore({ HOME: home });

    const coreFile = await readCoreFile(join(home, ".dark-matter"));
    const info = await connect(coreFile).trpc.core.info.query();
    expect(info.home).toBe(join(home, ".dark-matter"));
  });
});

describe("stopping the core", () => {
  test("removes core.json, releases core.lock and closes connections", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    let closed = 0;
    const { trpc } = connect(core, { onClose: () => closed++ });
    await trpc.core.info.query();

    await core.stop();

    await expect(access(join(libraryHome, "core.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(libraryHome, "core.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect.poll(() => closed).toBeGreaterThan(0);
  });
});
