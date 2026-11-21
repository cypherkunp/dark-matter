import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bootCore, connect, tempHome } from "./harness";

describe("settings.json", () => {
  test("starts from the default preferences and writes nothing until something changes", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });

    const settings = await connect(core).trpc.settings.get.query();

    expect(settings.preferences).toEqual({
      activityRetention: 30,
      scheduledScanTime: "09:00",
      startAtLogin: true,
      trashRetentionDays: 30,
    });
    expect(await readdir(libraryHome)).not.toContain("settings.json");
  });

  test("saving a preference writes settings.json with sorted keys and no temp files left", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    const { trpc } = connect(core);

    await trpc.settings.updatePreferences.mutate({ scheduledScanTime: "07:30" });

    expect(await readFile(join(libraryHome, "settings.json"), "utf8")).toBe(
      `{
  "dismissedSuggestedProjects": [],
  "ignoredFindings": [],
  "preferences": {
    "activityRetention": 30,
    "scheduledScanTime": "07:30",
    "startAtLogin": true,
    "trashRetentionDays": 30
  }
}
`,
    );
    expect((await readdir(libraryHome)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect((await trpc.settings.get.query()).preferences.scheduledScanTime).toBe("07:30");
  });

  test("saving one preference leaves the others as they were", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    const { trpc } = connect(core);

    await trpc.settings.updatePreferences.mutate({ scheduledScanTime: "07:30" });
    await trpc.settings.updatePreferences.mutate({ startAtLogin: false });

    expect((await trpc.settings.get.query()).preferences).toMatchObject({
      scheduledScanTime: "07:30",
      startAtLogin: false,
    });
  });

  test("a saved preference survives a restart", async () => {
    const { home, libraryHome } = await tempHome();
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    const first = await bootCore(env);
    await connect(first).trpc.settings.updatePreferences.mutate({ activityRetention: "forever" });
    await first.stop();

    const second = await bootCore(env);
    expect((await connect(second).trpc.settings.get.query()).preferences.activityRetention).toBe("forever");
  });

  test("refuses a preference the schema doesn't allow", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });

    await expect(
      connect(core).trpc.settings.updatePreferences.mutate({ scheduledScanTime: "25:00" }),
    ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
    expect(await readdir(libraryHome)).not.toContain("settings.json");
  });
});
