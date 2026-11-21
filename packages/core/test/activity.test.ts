import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivityEntry } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { bootCore, connect, tempHome } from "./harness";

const readLog = async (libraryHome: string, day: string) =>
  (await readFile(join(libraryHome, "activity", `${day}.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ActivityEntry);

describe("the Activity Log", () => {
  test("records a change with its time, client, action, subjects, result and files written", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    const { trpc } = connect(core);
    const before = Date.now();

    await trpc.settings.updatePreferences.mutate({ scheduledScanTime: "07:30" });

    const { entries } = await trpc.activity.list.query();
    expect(entries).toEqual([
      {
        id: expect.any(String),
        time: expect.any(String),
        client: "app",
        action: "settings.updatePreferences",
        subjects: [{ kind: "settings", id: "preferences" }],
        result: "ok",
        filesWritten: ["~/.dark-matter/settings.json"],
      },
    ]);
    const entry = entries[0] as ActivityEntry;
    expect(Date.parse(entry.time)).toBeGreaterThanOrEqual(before);
    // The day file is the truth; the list is served from the cache index.
    expect(await readLog(libraryHome, entry.time.slice(0, 10))).toEqual(entries);
  });

  test("records a failed change with its error", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    const { trpc } = connect(core);
    await writeFile(join(libraryHome, "settings.json"), "{ oops");
    await expect.poll(async () => (await trpc.ownedFiles.problems.query()).length).toBe(1);

    await expect(trpc.settings.updatePreferences.mutate({ startAtLogin: false })).rejects.toThrow();

    expect((await trpc.activity.list.query()).entries).toEqual([
      expect.objectContaining({
        action: "settings.updatePreferences",
        result: "error",
        error: { tag: "InvalidOwnedFile", message: expect.stringContaining("settings.json") },
        filesWritten: [],
      }),
    ]);
  });

  test("records discarding a hand edit", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    const { trpc } = connect(core);
    await writeFile(join(libraryHome, "settings.json"), "{ oops");
    await expect.poll(async () => (await trpc.ownedFiles.problems.query()).length).toBe(1);

    await trpc.ownedFiles.discard.mutate({ file: "settings.json" });

    expect((await trpc.activity.list.query()).entries).toEqual([
      expect.objectContaining({
        action: "ownedFiles.discard",
        subjects: [{ kind: "settings", id: "settings.json" }],
        result: "ok",
        filesWritten: ["~/.dark-matter/settings.json"],
      }),
    ]);
  });

  test("lists entries newest first, across day files", async () => {
    const { home, libraryHome } = await tempHome();
    const older: ActivityEntry = {
      id: "older",
      time: "2026-11-01T08:00:00.000Z",
      client: "cli",
      action: "settings.updatePreferences",
      subjects: [],
      result: "ok",
      filesWritten: [],
    };
    await mkdir(join(libraryHome, "activity"), { recursive: true });
    await writeFile(join(libraryHome, "activity", "2026-11-01.jsonl"), `${JSON.stringify(older)}\n`);
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    const { trpc } = connect(core);

    await trpc.settings.updatePreferences.mutate({ startAtLogin: false });
    await trpc.settings.updatePreferences.mutate({ startAtLogin: true });

    const { entries } = await trpc.activity.list.query();
    expect(entries.map((entry) => entry.id).at(-1)).toBe("older");
    expect(entries).toHaveLength(3);
    expect((entries[0]?.time ?? "") >= (entries[1]?.time ?? "")).toBe(true);
    expect((await trpc.activity.list.query({ limit: 1 })).entries).toHaveLength(1);
  });

  test("pushes an invalidation when an entry is recorded", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    const { trpc } = connect(core);
    const domains: string[] = [];
    let started = false;
    trpc.events.subscribe(undefined, {
      onStarted: () => (started = true),
      onData: (event) => domains.push(...event.domains),
    });
    await expect.poll(() => started).toBe(true);

    await trpc.settings.updatePreferences.mutate({ startAtLogin: false });

    await expect.poll(() => domains).toContain("activity");
  });
});

describe("state/ is a disposable cache", () => {
  test("deleting state/ loses nothing: the next start rebuilds the cache and Activity index", async () => {
    const { home, libraryHome } = await tempHome();
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    const first = await bootCore(env);
    const firstClient = connect(first);
    await firstClient.trpc.settings.updatePreferences.mutate({ scheduledScanTime: "06:00" });
    await firstClient.trpc.settings.updatePreferences.mutate({ activityRetention: 90 });
    const before = await firstClient.trpc.activity.list.query();
    expect(await readdir(join(libraryHome, "state"))).toContain("dark-matter.db");
    await first.stop();

    await rm(join(libraryHome, "state"), { recursive: true });

    const second = await bootCore(env);
    const { trpc } = connect(second);
    expect(await trpc.activity.list.query()).toEqual(before);
    expect((await trpc.settings.get.query()).preferences).toMatchObject({
      scheduledScanTime: "06:00",
      activityRetention: 90,
    });
  });

  test("a corrupt cache is dropped and rebuilt", async () => {
    const { home, libraryHome } = await tempHome();
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    const first = await bootCore(env);
    await connect(first).trpc.settings.updatePreferences.mutate({ startAtLogin: false });
    const before = await connect(first).trpc.activity.list.query();
    await first.stop();

    await rm(join(libraryHome, "state"), { recursive: true });
    await mkdir(join(libraryHome, "state"));
    await writeFile(join(libraryHome, "state", "dark-matter.db"), "this is not a database");

    const second = await bootCore(env);
    expect(await connect(second).trpc.activity.list.query()).toEqual(before);
  });
});
