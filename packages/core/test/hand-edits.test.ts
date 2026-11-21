import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CoreEvent } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { bootCore, connect, tempHome } from "./harness";

const savedSettings = async () => {
  const { home, libraryHome } = await tempHome();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  const client = connect(core);
  await client.trpc.settings.updatePreferences.mutate({ scheduledScanTime: "07:30" });
  return { core, libraryHome, trpc: client.trpc, path: join(libraryHome, "settings.json") };
};

const handEdit = (scheduledScanTime: string) => `${JSON.stringify({ preferences: { scheduledScanTime } }, null, 2)}\n`;

describe("hand edits to owned files", () => {
  test("a valid hand edit is picked up and pushed as an invalidation", async () => {
    const { trpc, path } = await savedSettings();
    const events: CoreEvent[] = [];
    let started = false;
    trpc.events.subscribe(undefined, { onStarted: () => (started = true), onData: (event) => events.push(event) });
    await expect.poll(() => started).toBe(true);

    await writeFile(path, handEdit("06:15"));

    await expect.poll(async () => (await trpc.settings.get.query()).preferences.scheduledScanTime).toBe("06:15");
    expect(events).toContainEqual({ type: "invalidate", domains: expect.arrayContaining(["settings"]) });
    // The core keeps the hand-edited text as it is.
    expect(await readFile(path, "utf8")).toBe(handEdit("06:15"));
  });

  test("an invalid hand edit is held: last good state served, error shown, edit never overwritten", async () => {
    const { trpc, path } = await savedSettings();

    await writeFile(path, '{ "preferences": { "scheduledScanTime": "noon" } }');

    await expect
      .poll(() => trpc.ownedFiles.problems.query())
      .toEqual([{ file: "settings.json", path, message: expect.stringContaining("scheduledScanTime") }]);
    expect((await trpc.settings.get.query()).preferences.scheduledScanTime).toBe("07:30");
    await expect(trpc.settings.updatePreferences.mutate({ startAtLogin: false })).rejects.toMatchObject({
      data: { tag: "InvalidOwnedFile" },
    });
    expect(await readFile(path, "utf8")).toBe('{ "preferences": { "scheduledScanTime": "noon" } }');
  });

  test("broken JSON is held too", async () => {
    const { trpc, path } = await savedSettings();

    await writeFile(path, '{ "preferences": ');

    await expect
      .poll(() => trpc.ownedFiles.problems.query())
      .toEqual([{ file: "settings.json", path, message: expect.stringContaining("not valid JSON") }]);
  });

  test("fixing the hand edit clears the error and applies it", async () => {
    const { trpc, path } = await savedSettings();
    await writeFile(path, "{ oops");
    await expect.poll(async () => (await trpc.ownedFiles.problems.query()).length).toBe(1);

    await writeFile(path, handEdit("22:05"));

    await expect.poll(() => trpc.ownedFiles.problems.query()).toEqual([]);
    expect((await trpc.settings.get.query()).preferences.scheduledScanTime).toBe("22:05");
  });

  test("discarding the hand edit restores the last good state on disk", async () => {
    const { trpc, path } = await savedSettings();
    const good = await readFile(path, "utf8");
    await writeFile(path, "{ oops");
    await expect.poll(async () => (await trpc.ownedFiles.problems.query()).length).toBe(1);

    await trpc.ownedFiles.discard.mutate({ file: "settings.json" });

    expect(await trpc.ownedFiles.problems.query()).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(good);
    await trpc.settings.updatePreferences.mutate({ startAtLogin: false });
    expect((await trpc.settings.get.query()).preferences).toMatchObject({
      scheduledScanTime: "07:30",
      startAtLogin: false,
    });
  });

  test("an invalid file found at start-up is held rather than overwritten", async () => {
    const { home, libraryHome } = await tempHome();
    const path = join(libraryHome, "settings.json");
    await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }).then((core) => core.stop());
    await writeFile(path, '{ "preferences": { "unknownPreference": 1 } }');

    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    const { trpc } = connect(core);

    expect(await trpc.ownedFiles.problems.query()).toEqual([
      { file: "settings.json", path, message: expect.stringContaining("unknownPreference") },
    ]);
    expect((await trpc.settings.get.query()).preferences.scheduledScanTime).toBe("09:00");
    await expect(trpc.settings.updatePreferences.mutate({ startAtLogin: false })).rejects.toMatchObject({
      data: { tag: "InvalidOwnedFile" },
    });
    expect(await readFile(path, "utf8")).toBe('{ "preferences": { "unknownPreference": 1 } }');
  });
});
