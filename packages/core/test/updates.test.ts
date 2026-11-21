import { readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { gitRepo } from "./agent-home";
import { fakeGitHub, skillMd } from "./fake-github";
import { bootCore, connect, fakeClock, fakeNotifier, localTime, tempHome } from "./harness";

const setup = async (
  fakes: { clock?: ReturnType<typeof fakeClock>; notifier?: ReturnType<typeof fakeNotifier> } = {},
) => {
  const { home, libraryHome } = await tempHome();
  const github = await fakeGitHub();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }, { github: { api: github.api }, ...fakes });
  const { trpc } = connect(core);
  const importPaths = async (input: string, paths: string[]) => {
    const preview = await trpc.importer.preview.query({ input });
    return trpc.importer.import.mutate({ input, commit: preview.commit, paths });
  };
  const lock = async () => JSON.parse(await readFile(join(libraryHome, "library-lock.json"), "utf8"));
  /** API calls made since `mark()`. */
  let from = 0;
  const mark = () => {
    from = github.requests.length;
  };
  const calls = () => github.requests.slice(from).map((request) => request.path);
  /** A Project with the given Skills delivered as Links or Copies. */
  const project = async (dir: string, skills: { key: string; mode: "link" | "copy" }[]) => {
    const path = await gitRepo(home, dir);
    await trpc.project.add.mutate({ path, agents: ["claude-code"] });
    await trpc.project.addSkills.mutate({ skills: skills.map((skill) => ({ path, ...skill })) });
    return path;
  };
  const library = (key: string, file = "SKILL.md") => join(libraryHome, "skills", ...key.split("/"), file);
  return { home, libraryHome, github, trpc, importPaths, lock, mark, calls, core, project, library };
};

const acmeSkills = {
  "skills/pdf/SKILL.md": skillMd("pdf", "Work with PDFs", "Use pdftotext.\n"),
  "skills/xlsx/SKILL.md": skillMd("xlsx", "Work with spreadsheets"),
};

describe("Updates for Imported Skills", () => {
  test("one head call per Source; a Skill is updated only when its own folder changed", async () => {
    const { github, trpc, importPaths, mark, calls } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf", "skills/xlsx"]);

    mark();
    expect((await trpc.importer.checkUpdates.mutate({})).updates).toEqual([]);
    expect(calls()).toEqual(["/repos/acme/skills/commits/main"]);

    await repo.commit({ "README.md": "unrelated\n" });
    mark();
    expect((await trpc.importer.checkUpdates.mutate({})).updates).toEqual([]);
    expect(calls()).toHaveLength(2);

    const head = await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs v2") });
    mark();
    const { updates } = await trpc.importer.checkUpdates.mutate({});
    expect(calls()).toHaveLength(2);
    expect(updates).toMatchObject([
      { key: "acme/skills/pdf", source: "acme/skills", ref: "main", head, modified: false },
    ]);
    // Never applied automatically.
    expect((await trpc.skill.get.query({ key: "acme/skills/pdf" })).body).toBe("Use pdftotext.\n");
    expect((await trpc.importer.updates.query()).updates).toMatchObject([{ key: "acme/skills/pdf" }]);
  });

  test("applying an update replaces the Library folder: every Link gets it and stale Copies show outdated", async () => {
    const { github, trpc, importPaths, lock, project, library } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf"]);
    const linked = await project("code/linked", [{ key: "acme/skills/pdf", mode: "link" }]);
    const copied = await project("code/copied", [{ key: "acme/skills/pdf", mode: "copy" }]);
    const v2 = skillMd("pdf", "PDFs v2", "Use qpdf.\n");
    const head = await repo.commit({ "skills/pdf/SKILL.md": v2, "skills/pdf/new.md": "new\n" });
    await trpc.importer.checkUpdates.mutate({});

    expect((await trpc.importer.updateDiff.query({ key: "acme/skills/pdf" })).patch).toContain("+Use qpdf.");
    const applied = await trpc.importer.applyUpdates.mutate({ updates: [{ key: "acme/skills/pdf" }] });

    expect(applied.skills).toEqual([{ key: "acme/skills/pdf", outcome: "updated", newKey: "acme/skills/pdf" }]);
    expect(await readFile(library("acme/skills/pdf"), "utf8")).toBe(v2);
    expect(await readFile(join(linked, ".claude/skills/pdf/new.md"), "utf8")).toBe("new\n");
    expect((await lock()).skills["acme/skills/pdf"]).toMatchObject({ commit: head, ref: "main" });
    expect((await trpc.library.list.query()).skills[0]).toMatchObject({ modified: false });
    expect((await trpc.project.skills.query({ path: copied }))[0]?.copyState).toBe("outdated");
    expect((await trpc.importer.updates.query()).updates).toEqual([]);
    const { entries } = await trpc.activity.list.query({});
    expect(entries[0]).toMatchObject({ action: "importer.applyUpdate", result: "ok" });
    // Only the Copy changed nothing in the repo.
    expect(await readFile(join(copied, ".agents/skills/pdf/SKILL.md"), "utf8")).not.toBe(v2);
  });

  test("a Modified Skill needs a choice; Take upstream puts my version in trash/", async () => {
    const { github, trpc, importPaths, libraryHome, library } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf"]);
    await writeFile(library("acme/skills/pdf"), "my edits\n");
    const v2 = skillMd("pdf", "PDFs v2");
    await repo.commit({ "skills/pdf/SKILL.md": v2 });

    const { updates } = await trpc.importer.checkUpdates.mutate({});
    expect(updates).toMatchObject([{ key: "acme/skills/pdf", modified: true }]);
    await expect(trpc.importer.applyUpdates.mutate({ updates: [{ key: "acme/skills/pdf" }] })).rejects.toMatchObject({
      data: { tag: "SkillModified" },
    });
    expect(await readFile(library("acme/skills/pdf"), "utf8")).toBe("my edits\n");

    await trpc.importer.applyUpdates.mutate({ updates: [{ key: "acme/skills/pdf", choice: "takeUpstream" }] });

    expect(await readFile(library("acme/skills/pdf"), "utf8")).toBe(v2);
    const [trashed = ""] = await readdir(join(libraryHome, "trash"));
    expect(await readFile(join(libraryHome, "trash", trashed, "pdf/SKILL.md"), "utf8")).toBe("my edits\n");
    expect((await trpc.library.list.query()).skills[0]?.modified).toBe(false);
  });

  test("Keep mine skips this upstream version and asks again on the next one", async () => {
    const { github, trpc, importPaths, library } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf"]);
    await writeFile(library("acme/skills/pdf"), "my edits\n");
    await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs v2") });
    await trpc.importer.checkUpdates.mutate({});

    expect(
      await trpc.importer.applyUpdates.mutate({ updates: [{ key: "acme/skills/pdf", choice: "keepMine" }] }),
    ).toEqual({ skills: [{ key: "acme/skills/pdf", outcome: "kept", newKey: "acme/skills/pdf" }] });

    expect(await readFile(library("acme/skills/pdf"), "utf8")).toBe("my edits\n");
    expect((await trpc.importer.checkUpdates.mutate({})).updates).toEqual([]);
    await repo.commit({ "README.md": "unrelated\n" });
    expect((await trpc.importer.checkUpdates.mutate({})).updates).toEqual([]);

    await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs v3") });
    expect((await trpc.importer.checkUpdates.mutate({})).updates).toMatchObject([
      { key: "acme/skills/pdf", modified: true },
    ]);
  });

  test("Detach makes it local/<name>, drops the Source and re-creates its Links", async () => {
    const { github, trpc, importPaths, lock, project, library } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf"]);
    const linked = await project("code/linked", [{ key: "acme/skills/pdf", mode: "link" }]);
    await writeFile(library("acme/skills/pdf"), "my edits\n");
    await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs v2") });
    await trpc.importer.checkUpdates.mutate({});

    const applied = await trpc.importer.applyUpdates.mutate({
      updates: [{ key: "acme/skills/pdf", choice: "detach" }],
    });

    expect(applied.skills).toEqual([{ key: "acme/skills/pdf", outcome: "detached", newKey: "local/pdf" }]);
    const { skills } = await lock();
    expect(Object.keys(skills)).toEqual(["local/pdf"]);
    expect(skills["local/pdf"]).toMatchObject({
      sourceType: "local",
      detachedFrom: { key: "acme/skills/pdf", source: "acme/skills" },
    });
    expect(skills["local/pdf"].commit).toBeUndefined();
    expect(await readFile(library("local/pdf"), "utf8")).toBe("my edits\n");
    expect(await readlink(join(linked, ".claude/skills/pdf"))).toBe(library("local/pdf", ""));
    expect(await trpc.project.skills.query({ path: linked })).toMatchObject([{ key: "local/pdf" }]);
    expect((await trpc.library.list.query()).skills).toMatchObject([{ key: "local/pdf", modified: false }]);
    // Never checked again.
    await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs v3") });
    expect((await trpc.importer.checkUpdates.mutate({})).updates).toEqual([]);
  });

  test("a Skill whose upstream is gone is Orphaned and kept as is, until Detach or re-point", async () => {
    const { github, trpc, importPaths, lock, library } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf", "skills/xlsx"]);

    // The Skill's path is removed upstream.
    await repo.commit({ "skills/pdf/SKILL.md": null });
    const view = await trpc.importer.checkUpdates.mutate({});
    expect(view.orphaned).toEqual([
      { key: "acme/skills/pdf", source: "acme/skills", reason: expect.stringContaining("skills/pdf") },
    ]);
    expect(await readFile(library("acme/skills/pdf"), "utf8")).toBe(acmeSkills["skills/pdf/SKILL.md"]);
    expect((await trpc.library.list.query()).skills).toMatchObject([
      { key: "acme/skills/pdf", orphaned: true },
      { key: "acme/skills/xlsx", orphaned: false },
    ]);

    // The whole repo goes.
    repo.remove();
    expect((await trpc.importer.checkUpdates.mutate({})).orphaned.map((skill) => skill.key)).toEqual([
      "acme/skills/pdf",
      "acme/skills/xlsx",
    ]);
    expect(Object.keys((await lock()).skills)).toEqual(["acme/skills/pdf", "acme/skills/xlsx"]);

    // Re-point to where it moved; Detach the other.
    const moved = await github.repo("acme/moved", { "pdf/SKILL.md": skillMd("pdf", "PDFs, moved") });
    await trpc.importer.repoint.mutate({
      key: "acme/skills/pdf",
      input: "https://github.com/acme/moved/tree/main/pdf",
    });
    await trpc.importer.detach.mutate({ key: "acme/skills/xlsx" });

    const { skills } = await lock();
    expect(skills["acme/skills/pdf"]).toMatchObject({
      source: "acme/moved",
      ref: "main",
      commit: moved.head(),
      skillPath: "pdf/SKILL.md",
    });
    expect(skills["acme/skills/pdf"].orphaned).toBeUndefined();
    expect(skills["local/xlsx"]).toMatchObject({ sourceType: "local" });
    expect(await readFile(library("acme/skills/pdf"), "utf8")).toBe(skillMd("pdf", "PDFs, moved"));
    expect((await trpc.importer.checkUpdates.mutate({})).orphaned).toEqual([]);
  });

  test("a Skill pinned to a tag only moves when re-pointed", async () => {
    const { github, trpc, importPaths, lock, mark, calls, library } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    repo.tag("v1");
    await importPaths("https://github.com/acme/skills/tree/v1/skills/pdf", ["skills/pdf"]);
    expect((await lock()).skills["acme/skills/pdf"]).toMatchObject({ ref: "v1", refType: "tag" });

    await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs v2") });
    repo.tag("v2");
    mark();
    expect((await trpc.importer.checkUpdates.mutate({})).updates).toEqual([]);
    expect(calls()).toEqual([]);

    await trpc.importer.repoint.mutate({
      key: "acme/skills/pdf",
      input: "https://github.com/acme/skills/tree/v2/skills/pdf",
    });
    expect((await lock()).skills["acme/skills/pdf"]).toMatchObject({
      ref: "v2",
      refType: "tag",
      commit: repo.head("v2"),
    });
    expect(await readFile(library("acme/skills/pdf"), "utf8")).toBe(skillMd("pdf", "PDFs v2"));
  });

  test("a tree URL whose branch name contains / resolves the whole branch", async () => {
    const { github, trpc, importPaths, lock } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    await repo.commit({ "x/SKILL.md": skillMd("x", "Decoy") }, "feature/beta");
    const head = await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs, beta") }, "feature/beta-2");

    const preview = await trpc.importer.preview.query({
      input: "https://github.com/acme/skills/tree/feature/beta-2/skills/pdf",
    });
    expect(preview).toMatchObject({ ref: "feature/beta-2", commit: head, subpath: "skills/pdf" });
    expect(preview.skills).toMatchObject([{ description: "PDFs, beta", path: "skills/pdf" }]);

    await importPaths("https://github.com/acme/skills/tree/feature/beta-2/skills/pdf", ["skills/pdf"]);
    expect((await lock()).skills["acme/skills/pdf"]).toMatchObject({ ref: "feature/beta-2" });
    expect((await lock()).skills["acme/skills/pdf"].refType).toBeUndefined();
    const v3 = await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs, beta 3") }, "feature/beta-2");
    expect((await trpc.importer.checkUpdates.mutate({})).updates).toMatchObject([{ head: v3 }]);
  });

  test("last head seen, rate limit and auth status are cached in SQLite only", async () => {
    const { github, trpc, importPaths, lock, libraryHome } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf"]);
    const before = JSON.stringify(await lock());
    await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs v2") });

    const view = await trpc.importer.checkUpdates.mutate({});

    expect(view.sources).toEqual([
      { source: "acme/skills", ref: "main", head: repo.head(), checkedAt: expect.any(String), error: null },
    ]);
    expect(view.github).toMatchObject({ auth: "anonymous", rateLimit: { remaining: expect.any(Number), limit: 5000 } });
    expect(JSON.stringify(await lock())).toBe(before);
    expect(await readdir(libraryHome)).not.toContain("updates.json");

    github.rateLimited = true;
    await expect(trpc.importer.checkUpdates.mutate({})).rejects.toMatchObject({ data: { tag: "RateLimited" } });
    const limited = await trpc.importer.updates.query();
    expect(limited.github?.rateLimit?.remaining).toBe(0);
    expect(limited.sources[0]).toMatchObject({ head: null, error: expect.stringContaining("rate limit") });
    // A rate limit isn't an Orphaned upstream.
    expect(limited.orphaned).toEqual([]);
  });

  test("the Scheduled Scan checks for updates and notifies, but never applies them", async () => {
    const clock = fakeClock(localTime(20, 8));
    const notifier = fakeNotifier();
    const { github, trpc, importPaths, library } = await setup({ clock, notifier });
    const repo = await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf"]);
    await trpc.scan.run.mutate();
    await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs v2") });

    clock.set(localTime(20, 9));

    await expect
      .poll(() => notifier.sent.filter((sent) => sent.path === "/library/updates"))
      .toEqual([{ title: "1 Skill update", body: "acme/skills/pdf", path: "/library/updates" }]);
    expect((await trpc.importer.updates.query()).updates).toMatchObject([{ key: "acme/skills/pdf" }]);
    expect(await readFile(library("acme/skills/pdf"), "utf8")).toBe(acmeSkills["skills/pdf/SKILL.md"]);
    const { entries } = await trpc.activity.list.query({});
    expect(entries.find((entry) => entry.action === "importer.checkUpdates")).toMatchObject({
      client: "scheduled-scan",
    });
  });

  test("the Updates list survives losing the cache: the next check rebuilds it", async () => {
    const { github, trpc, importPaths, libraryHome, core } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf"]);
    await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs v2") });
    await trpc.importer.checkUpdates.mutate({});
    await core.stop();
    await rm(join(libraryHome, "state"), { recursive: true, force: true });

    const again = await bootCore(
      { HOME: join(libraryHome, ".."), DARK_MATTER_HOME: libraryHome },
      { github: { api: github.api } },
    );
    const { trpc: fresh } = connect(again);
    expect((await fresh.importer.updates.query()).updates).toEqual([]);
    expect((await fresh.importer.checkUpdates.mutate({})).updates).toMatchObject([{ key: "acme/skills/pdf" }]);
  });
});
