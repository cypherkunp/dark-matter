import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivityEntry } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { bootCore, connect, fakeClock, tempHome } from "./harness";

const entry = (id: string, time: string, fields: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id,
  time,
  client: "app",
  action: "project.addSkills",
  subjects: [],
  result: "ok",
  filesWritten: [],
  ...fields,
});

/** Writes real day files (one per UTC day of the entries) before the core starts. */
const seedLog = async (libraryHome: string, entries: ActivityEntry[]) => {
  const dir = join(libraryHome, "activity");
  await mkdir(dir, { recursive: true });
  const days = Map.groupBy(entries, (item) => item.time.slice(0, 10));
  for (const [day, items] of days) {
    await writeFile(join(dir, `${day}.jsonl`), items.map((item) => `${JSON.stringify(item)}\n`).join(""));
  }
};

const setup = async (entries: ActivityEntry[], now = new Date("2026-11-21T12:00:30.000Z")) => {
  const { home, libraryHome } = await tempHome();
  await seedLog(libraryHome, entries);
  const clock = fakeClock(now);
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }, { clock });
  return { home, libraryHome, clock, trpc: connect(core).trpc };
};

const ids = (list: { entries: ActivityEntry[] }) => list.entries.map((item) => item.id);

const log = [
  entry("adopt-pdf", "2026-11-18T09:00:00.000Z", {
    action: "adopt.apply",
    subjects: [{ kind: "skill", id: "anthropics/skills/pdf" }],
    filesWritten: ["~/.dark-matter/library-lock.json"],
  }),
  entry("add-pdf", "2026-11-19T10:00:00.000Z", {
    subjects: [
      { kind: "project", id: "/work/site" },
      { kind: "skill", id: "anthropics/skills/pdf" },
    ],
    filesWritten: ["/work/site/.claude/skills/pdf"],
  }),
  entry("failed-add", "2026-11-20T11:00:00.000Z", {
    client: "cli",
    subjects: [
      { kind: "project", id: "/work/api" },
      { kind: "skill", id: "local/docx" },
    ],
    result: "error",
    error: { tag: "NameConflict", message: "Two Project Skills are both delivered as docx" },
  }),
  entry("prefs", "2026-11-21T08:00:00.000Z", {
    action: "settings.updatePreferences",
    subjects: [{ kind: "settings", id: "preferences" }],
  }),
  // The newest entry is a Scheduled Scan, so no daily run is due when the core starts.
  entry("scan", "2026-11-21T12:00:00.000Z", { client: "scheduled-scan", action: "scan.run" }),
];

describe("querying the Activity Log", () => {
  test("filters to one Skill's entries, newest first", async () => {
    const { trpc } = await setup(log);
    expect(ids(await trpc.activity.list.query({ skill: "anthropics/skills/pdf" }))).toEqual(["add-pdf", "adopt-pdf"]);
  });

  test("filters to one Project's entries", async () => {
    const { trpc } = await setup(log);
    expect(ids(await trpc.activity.list.query({ project: "/work/api" }))).toEqual(["failed-add"]);
  });

  test("filters by action and client, matching any of the values given", async () => {
    const { trpc } = await setup(log);
    expect(ids(await trpc.activity.list.query({ actions: ["scan.run", "adopt.apply"] }))).toEqual([
      "scan",
      "adopt-pdf",
    ]);
    expect(ids(await trpc.activity.list.query({ clients: ["cli", "scheduled-scan"] }))).toEqual(["scan", "failed-add"]);
    expect(ids(await trpc.activity.list.query({ actions: ["project.addSkills"], clients: ["app"] }))).toEqual([
      "add-pdf",
    ]);
  });

  test("shows failures only, with their errors", async () => {
    const { trpc } = await setup(log);
    expect((await trpc.activity.list.query({ failuresOnly: true })).entries).toEqual([
      expect.objectContaining({
        id: "failed-add",
        result: "error",
        error: { tag: "NameConflict", message: "Two Project Skills are both delivered as docx" },
      }),
    ]);
  });

  test("filters by a date range: from inclusive, to exclusive", async () => {
    const { trpc } = await setup(log);
    expect(
      ids(await trpc.activity.list.query({ from: "2026-11-19T10:00:00.000Z", to: "2026-11-20T11:00:00.000Z" })),
    ).toEqual(["add-pdf"]);
    expect(ids(await trpc.activity.list.query({ from: "2026-11-21T00:00:00.000Z" }))).toEqual(["scan", "prefs"]);
    expect(ids(await trpc.activity.list.query({ to: "2026-11-19T00:00:00.000Z" }))).toEqual(["adopt-pdf"]);
  });

  test("searches the action, client, subjects, files written and error, ignoring case", async () => {
    const { trpc } = await setup(log);
    const search = async (text: string) => ids(await trpc.activity.list.query({ search: text }));
    expect(await search("SKILLS/PDF")).toEqual(["add-pdf", "adopt-pdf"]);
    expect(await search("library-lock.json")).toEqual(["adopt-pdf"]);
    expect(await search("delivered as docx")).toEqual(["failed-add"]);
    expect(await search("adopt.")).toEqual(["adopt-pdf"]);
    expect(await search("scheduled-scan")).toEqual(["scan"]);
    // Field names and bookkeeping (ids, times, "ok") aren't searched.
    expect(await search("ok")).toEqual([]);
    expect(await search("filesWritten")).toEqual([]);
    expect(await search("2026-11")).toEqual([]);
    expect(await search("project")).toEqual(["failed-add", "add-pdf"]);
  });

  test("combines filters", async () => {
    const { trpc } = await setup(log);
    expect(ids(await trpc.activity.list.query({ search: "work", failuresOnly: true }))).toEqual(["failed-add"]);
    expect(ids(await trpc.activity.list.query({ skill: "anthropics/skills/pdf", project: "/work/api" }))).toEqual([]);
  });

  test("exports the whole filtered view as JSON, with no limit", async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      entry(`add-${String(index).padStart(2, "0")}`, `2026-11-19T10:${String(index).padStart(2, "0")}:00.000Z`),
    );
    const { trpc } = await setup([...log, ...many]);

    const exported = await trpc.activity.export.query({ actions: ["project.addSkills"], clients: ["app"] });

    expect(exported).toEqual({
      exportedAt: "2026-11-21T12:00:30.000Z",
      filter: { actions: ["project.addSkills"], clients: ["app"] },
      entries: expect.any(Array),
    });
    expect(exported.entries).toHaveLength(31);
    expect(exported.entries[0]?.id).toBe("add-29");
    expect(exported.entries.at(-1)?.id).toBe("add-pdf");
    expect((await trpc.activity.list.query({ actions: ["project.addSkills"], limit: 10 })).entries).toHaveLength(10);
  });

  test("looking at, searching and exporting the log records nothing", async () => {
    const { libraryHome, trpc } = await setup(log);
    const before = await readdir(join(libraryHome, "activity"));

    await trpc.activity.list.query({ search: "pdf" });
    await trpc.activity.list.query({ skill: "local/docx", failuresOnly: true });
    await trpc.activity.export.query({});

    expect(ids(await trpc.activity.list.query())).toEqual(["scan", "prefs", "failed-add", "add-pdf", "adopt-pdf"]);
    expect(await readdir(join(libraryHome, "activity"))).toEqual(before);
  });
});
