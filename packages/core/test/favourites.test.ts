import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
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
  const settings = async () => JSON.parse(await readFile(join(libraryHome, "settings.json"), "utf8"));
  const newSkills = async () =>
    (await trpc.inbox.list.query()).newSkills.map((group) => ({
      source: group.source,
      paths: group.findings.map((finding) => finding.path),
    }));
  return { home, libraryHome, github, trpc, importPaths, settings, newSkills };
};

const acmeSkills = {
  "skills/pdf/SKILL.md": skillMd("pdf", "Work with PDFs"),
  "skills/xlsx/SKILL.md": skillMd("xlsx", "Work with spreadsheets"),
};

describe("Favourites", () => {
  test("starring a Skill and a Source; the Favourites view shows both, kept in settings.json", async () => {
    const { github, trpc, importPaths, settings } = await setup();
    await github.repo("acme/skills", acmeSkills);
    await github.repo("other/tools", { "lint/SKILL.md": skillMd("lint", "Lint things") });
    await importPaths("acme/skills", ["skills/pdf", "skills/xlsx"]);
    await importPaths("other/tools", ["lint"]);

    await trpc.favourites.setSkill.mutate({ key: "other/tools/lint", starred: true });
    await trpc.favourites.setSource.mutate({ source: "Acme/Skills", starred: true });

    expect(await trpc.favourites.get.query()).toEqual({ skills: ["other/tools/lint"], sources: ["Acme/Skills"] });
    expect((await settings()).favourites).toEqual({ skills: ["other/tools/lint"], sources: ["Acme/Skills"] });
    const view = await trpc.favourites.view.query();
    expect(view.skills.map((skill) => skill.key)).toEqual(["acme/skills/pdf", "acme/skills/xlsx", "other/tools/lint"]);
    expect(view.sources).toMatchObject([{ source: "Acme/Skills", skills: 2, newSkills: 0 }]);

    // Starring again is a no-op; the case of a Source doesn't matter.
    await trpc.favourites.setSource.mutate({ source: "acme/skills", starred: true });
    expect((await trpc.favourites.get.query()).sources).toEqual(["Acme/Skills"]);
    await trpc.favourites.setSource.mutate({ source: "acme/skills", starred: false });
    await trpc.favourites.setSkill.mutate({ key: "other/tools/lint", starred: false });
    expect(await trpc.favourites.get.query()).toEqual({ skills: [], sources: [] });
    expect((await trpc.favourites.view.query()).skills).toEqual([]);

    const { entries } = await trpc.activity.list.query({});
    // Newest first: unstar Skill, unstar Source, star again, star.
    expect(entries.slice(0, 5).map((entry) => entry.action)).toEqual([
      "favourites.setSkill",
      "favourites.setSource",
      "favourites.setSource",
      "favourites.setSource",
      "favourites.setSkill",
    ]);
  });

  test("a Skill not in the Library can't be starred; a starred Skill follows a Namespace rename", async () => {
    const { github, trpc, importPaths } = await setup();
    await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf"]);
    await expect(trpc.favourites.setSkill.mutate({ key: "acme/skills/nope", starred: true })).rejects.toMatchObject({
      data: { tag: "SkillNotFound" },
    });

    await trpc.favourites.setSkill.mutate({ key: "acme/skills/pdf", starred: true });
    const plan = await trpc.namespace.plan.query({ from: "acme/skills", to: "mine/docs" });
    await trpc.namespace.rename.mutate({ from: "acme/skills", to: "mine/docs", planId: plan.planId });

    expect((await trpc.favourites.get.query()).skills).toEqual(["mine/docs/pdf"]);
  });

  test("a starred Source that gains Skills puts them in the Inbox on the update check, and never Imports them", async () => {
    const { github, trpc, importPaths, newSkills } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf"]);
    await trpc.favourites.setSource.mutate({ source: "acme/skills", starred: true });

    // The first check learns what the Source has: Skills you skipped at Import aren't new.
    await trpc.importer.checkUpdates.mutate({});
    expect(await newSkills()).toEqual([]);

    await repo.commit({
      "skills/docx/SKILL.md": skillMd("docx", "Word files"),
      "skills/pptx/SKILL.md": skillMd("pptx", "Slides"),
    });
    await trpc.importer.checkUpdates.mutate({});

    const inbox = await trpc.inbox.list.query();
    expect(inbox.newSkills).toMatchObject([
      {
        source: "acme/skills",
        findings: [
          { id: "new-skill:acme/skills:skills/docx", name: "docx", path: "skills/docx" },
          { id: "new-skill:acme/skills:skills/pptx", name: "pptx", path: "skills/pptx" },
        ],
      },
    ]);
    expect(inbox.count).toBe(2);
    expect((await trpc.library.list.query()).skills.map((skill) => skill.key)).toEqual(["acme/skills/pdf"]);
    expect((await trpc.favourites.view.query()).sources).toMatchObject([{ source: "acme/skills", newSkills: 2 }]);

    // Importing one or ignoring one clears it; the rest stay.
    await importPaths("acme/skills", ["skills/docx"]);
    expect(await newSkills()).toEqual([{ source: "acme/skills", paths: ["skills/pptx"] }]);
    await trpc.inbox.ignore.mutate({ id: "new-skill:acme/skills:skills/pptx" });
    expect(await newSkills()).toEqual([]);
    expect((await trpc.inbox.list.query()).ignoredCount).toBe(1);
  });

  test("a starred Source with nothing in the Library is checked on its default branch; unstarring hides its item", async () => {
    const { github, trpc, newSkills } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills, { defaultBranch: "trunk" });
    await trpc.favourites.setSource.mutate({ source: "acme/skills", starred: true });
    await trpc.importer.checkUpdates.mutate({});
    await repo.commit({ "skills/docx/SKILL.md": skillMd("docx", "Word files") }, "trunk");
    await trpc.importer.checkUpdates.mutate({});
    expect(await newSkills()).toEqual([{ source: "acme/skills", paths: ["skills/docx"] }]);

    await trpc.favourites.setSource.mutate({ source: "acme/skills", starred: false });
    expect(await newSkills()).toEqual([]);
  });

  test("the Scheduled Scan notifies about new Skills in a starred Source", async () => {
    const clock = fakeClock(localTime(20, 8));
    const notifier = fakeNotifier();
    const { github, trpc, importPaths } = await setup({ clock, notifier });
    const repo = await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf"]);
    await trpc.favourites.setSource.mutate({ source: "acme/skills", starred: true });
    await trpc.importer.checkUpdates.mutate({});
    await trpc.scan.run.mutate();
    await repo.commit({ "skills/docx/SKILL.md": skillMd("docx", "Word files") });

    clock.set(localTime(20, 9));

    await expect
      .poll(() => notifier.sent.filter((sent) => sent.path === "/inbox"))
      .toEqual([{ title: "New Skills in ⭐ acme/skills", body: "docx", path: "/inbox" }]);
    expect((await trpc.library.list.query()).skills.map((skill) => skill.key)).toEqual(["acme/skills/pdf"]);
  });
});
