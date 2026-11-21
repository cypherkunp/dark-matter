import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fakeGitHub, skillMd } from "./fake-github";
import { fakeSkillsSh } from "./fake-skills-sh";
import { bootCore, connect, fakeClock, tempHome } from "./harness";

const setup = async (listings: Parameters<typeof fakeSkillsSh>[0] = []) => {
  const { home, libraryHome } = await tempHome();
  const github = await fakeGitHub();
  const skillsSh = await fakeSkillsSh(listings);
  const clock = fakeClock(new Date("2026-11-21T10:00:00Z"));
  const core = await bootCore(
    { HOME: home, DARK_MATTER_HOME: libraryHome },
    { clock, github: { api: github.api, ghToken: async () => null }, skillsSh: { api: skillsSh.api } },
  );
  const { trpc } = connect(core);
  return { home, libraryHome, github, skillsSh, clock, trpc };
};

describe("skills.sh search", () => {
  test("searching lists each listing's Source, slug and install count", async () => {
    const { trpc } = await setup([
      { source: "acme/skills", skillId: "pdf", installs: 1200 },
      { source: "other/tools", skillId: "pdf-forms", name: "PDF forms", installs: 3 },
      { source: "acme/skills", skillId: "xlsx", installs: 40 },
    ]);

    const result = await trpc.skillsSh.search.query({ query: "pdf" });

    expect(result).toEqual({
      query: "pdf",
      rateLimitedUntil: null,
      skills: [
        {
          id: "acme/skills/pdf",
          source: "acme/skills",
          slug: "pdf",
          name: "pdf",
          installs: 1200,
          url: "https://skills.sh/acme/skills/pdf",
          key: null,
        },
        {
          id: "other/tools/pdf-forms",
          source: "other/tools",
          slug: "pdf-forms",
          name: "PDF forms",
          installs: 3,
          url: "https://skills.sh/other/tools/pdf-forms",
          key: null,
        },
      ],
    });
  });

  test("a query under 2 characters asks skills.sh nothing", async () => {
    const { trpc, skillsSh } = await setup([{ source: "acme/skills", skillId: "pdf" }]);

    expect(await trpc.skillsSh.search.query({ query: " p " })).toEqual({
      query: "p",
      skills: [],
      rateLimitedUntil: null,
    });
    expect(skillsSh.requests).toEqual([]);
  });

  test("a repeated query is answered from the cache, not from skills.sh", async () => {
    const { trpc, skillsSh, clock } = await setup([{ source: "acme/skills", skillId: "pdf" }]);

    await trpc.skillsSh.search.query({ query: "pdf" });
    await trpc.skillsSh.search.query({ query: "PDF" });
    expect(skillsSh.requests).toHaveLength(1);

    clock.set(new Date("2026-11-21T10:06:00Z"));
    await trpc.skillsSh.search.query({ query: "pdf" });
    expect(skillsSh.requests).toHaveLength(2);
  });

  test("the core sends at most 30 searches a minute, then reports when results resume", async () => {
    const { trpc, skillsSh, clock } = await setup([{ source: "acme/skills", skillId: "pdf" }]);
    for (let index = 0; index < 30; index++) {
      const result = await trpc.skillsSh.search.query({ query: `pdf ${index}` });
      expect(result.rateLimitedUntil).toBeNull();
    }

    const limited = await trpc.skillsSh.search.query({ query: "pdf more" });

    expect(limited).toEqual({ query: "pdf more", skills: [], rateLimitedUntil: "2026-11-21T10:01:00.000Z" });
    expect(skillsSh.requests).toHaveLength(30);
    clock.set(new Date("2026-11-21T10:01:00Z"));
    await trpc.skillsSh.search.query({ query: "pdf" });
    expect(skillsSh.requests).toHaveLength(31);
  });

  test("a 429 from skills.sh is a friendly wait, not a failure, and is honoured until Retry-After", async () => {
    const { trpc, skillsSh, clock } = await setup([{ source: "acme/skills", skillId: "pdf" }]);
    skillsSh.rateLimited = true;

    const limited = await trpc.skillsSh.search.query({ query: "pdf" });

    expect(limited).toEqual({ query: "pdf", skills: [], rateLimitedUntil: "2026-11-21T10:01:00.000Z" });
    skillsSh.rateLimited = false;
    await trpc.skillsSh.search.query({ query: "xlsx" });
    expect(skillsSh.requests).toHaveLength(1);
    clock.set(new Date("2026-11-21T10:01:00Z"));
    expect((await trpc.skillsSh.search.query({ query: "pdf" })).skills).toHaveLength(1);
  });

  test("skills.sh being down is a SourceUnreachable error", async () => {
    const { home, libraryHome } = await tempHome();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    const { trpc } = connect(core);

    await expect(trpc.skillsSh.search.query({ query: "pdf" })).rejects.toMatchObject({
      data: { tag: "SourceUnreachable" },
    });
  });
});

describe("skills.sh Get", () => {
  test("Get resolves the listing to its repo and folder, Imports only that Skill, and search then marks it in Library", async () => {
    const { trpc, github, libraryHome } = await setup([
      { source: "acme/skills", skillId: "pdf", installs: 10 },
      { source: "acme/skills", skillId: "xlsx", installs: 5 },
    ]);
    const repo = await github.repo("acme/skills", {
      "skills/pdf/SKILL.md": skillMd("pdf", "Work with PDFs"),
      "skills/xlsx/SKILL.md": skillMd("xlsx", "Work with spreadsheets"),
    });
    expect((await trpc.skillsSh.search.query({ query: "acme" })).skills.map((skill) => skill.key)).toEqual([
      null,
      null,
    ]);

    const result = await trpc.skillsSh.get.mutate({ id: "acme/skills/pdf" });

    expect(result).toEqual({
      source: "acme/skills",
      ref: "main",
      commit: repo.head(),
      skills: [{ key: "acme/skills/pdf", path: "skills/pdf", outcome: "imported" }],
    });
    const lock = JSON.parse(await readFile(join(libraryHome, "library-lock.json"), "utf8"));
    expect(Object.keys(lock.skills)).toEqual(["acme/skills/pdf"]);
    expect(lock.skills["acme/skills/pdf"]).toMatchObject({
      source: "acme/skills",
      sourceType: "github",
      ref: "main",
      commit: repo.head(),
      skillPath: "skills/pdf/SKILL.md",
    });
    expect((await trpc.skillsSh.search.query({ query: "acme" })).skills.map((skill) => skill.key)).toEqual([
      "acme/skills/pdf",
      null,
    ]);
  });

  test("Get again doesn't duplicate: it reports the Skill up to date", async () => {
    const { trpc, github } = await setup();
    await github.repo("acme/skills", { "skills/pdf/SKILL.md": skillMd("pdf", "Work with PDFs") });
    await trpc.skillsSh.get.mutate({ id: "acme/skills/pdf" });

    const again = await trpc.skillsSh.get.mutate({ id: "acme/skills/pdf" });

    expect(again.skills).toEqual([{ key: "acme/skills/pdf", path: "skills/pdf", outcome: "upToDate" }]);
  });

  test("a listing whose Skill isn't in the repo any more is ImportSkillNotFound", async () => {
    const { trpc, github } = await setup();
    await github.repo("acme/skills", { "skills/pdf/SKILL.md": skillMd("pdf", "Work with PDFs") });

    await expect(trpc.skillsSh.get.mutate({ id: "acme/skills/gone" })).rejects.toMatchObject({
      data: { tag: "ImportSkillNotFound" },
    });
  });
});
