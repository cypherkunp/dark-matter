import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivityEntry } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { bootCore, connect, fakeClock, localTime, tempHome } from "./harness";

/** One real day file per UTC day, each holding one entry at noon. */
const seedDays = async (libraryHome: string, days: string[]) => {
  const dir = join(libraryHome, "activity");
  await mkdir(dir, { recursive: true });
  for (const day of days) {
    const entry: ActivityEntry = {
      id: day,
      time: `${day}T12:00:00.000Z`,
      client: "app",
      action: "project.add",
      subjects: [],
      result: "ok",
      filesWritten: [],
    };
    await writeFile(join(dir, `${day}.jsonl`), `${JSON.stringify(entry)}\n`);
  }
};

const setRetention = async (libraryHome: string, activityRetention: number | "forever") => {
  await mkdir(libraryHome, { recursive: true });
  await writeFile(join(libraryHome, "settings.json"), JSON.stringify({ preferences: { activityRetention } }));
};

const dayFiles = async (libraryHome: string) => (await readdir(join(libraryHome, "activity"))).sort();

const boot = async (libraryHome: string, home: string, now: Date) => {
  const clock = fakeClock(now);
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }, { clock });
  return { clock, trpc: connect(core).trpc };
};

describe("Activity Log retention", () => {
  test("on start, deletes day files older than 30 days by default, from disk and from the list", async () => {
    const { home, libraryHome } = await tempHome();
    await seedDays(libraryHome, ["2026-10-01", "2026-10-21", "2026-10-22", "2026-11-20"]);

    const { trpc } = await boot(libraryHome, home, new Date("2026-11-21T12:00:00.000Z"));

    expect(await dayFiles(libraryHome)).toEqual(["2026-10-22.jsonl", "2026-11-20.jsonl"]);
    expect((await trpc.activity.list.query()).entries.map((entry) => entry.id)).toEqual(["2026-11-20", "2026-10-22"]);
  });

  test("keeps everything when retention is Forever", async () => {
    const { home, libraryHome } = await tempHome();
    await seedDays(libraryHome, ["2024-01-01", "2026-11-20"]);
    await setRetention(libraryHome, "forever");

    await boot(libraryHome, home, new Date("2026-11-21T12:00:00.000Z"));

    expect(await dayFiles(libraryHome)).toEqual(["2024-01-01.jsonl", "2026-11-20.jsonl"]);
  });

  test("shortening retention in Settings deletes the older files at once", async () => {
    const { home, libraryHome } = await tempHome();
    await seedDays(libraryHome, ["2026-11-01", "2026-11-14", "2026-11-20"]);
    const { trpc } = await boot(libraryHome, home, new Date("2026-11-21T12:00:00.000Z"));

    await trpc.settings.updatePreferences.mutate({ activityRetention: 7 });

    const files = await dayFiles(libraryHome);
    expect(files).toEqual(["2026-11-14.jsonl", "2026-11-20.jsonl", "2026-11-21.jsonl"]);
    expect((await trpc.activity.list.query()).entries.map((entry) => entry.action)).toEqual([
      "settings.updatePreferences",
      "project.add",
      "project.add",
    ]);
  });

  test("the daily run deletes files that have aged past retention", async () => {
    const { home, libraryHome } = await tempHome();
    await setRetention(libraryHome, 7);
    await seedDays(libraryHome, ["2026-11-15"]);
    const { clock, trpc } = await boot(libraryHome, home, localTime(21, 12));
    await trpc.scan.run.mutate();
    expect(await dayFiles(libraryHome)).toContain("2026-11-15.jsonl");

    clock.set(localTime(24, 9));

    await expect.poll(() => dayFiles(libraryHome)).not.toContain("2026-11-15.jsonl");
    await expect
      .poll(async () => (await trpc.activity.list.query()).entries.map((entry) => entry.id))
      .not.toContain("2026-11-15");
  });
});
