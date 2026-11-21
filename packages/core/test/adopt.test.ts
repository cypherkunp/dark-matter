import { lstat, mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentHome, snapshotTree } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

const setup = async () => {
  const { home, libraryHome } = await tempHome();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  const { trpc } = connect(core);
  const fixture = { home, ...agentHome(home) };
  /** Scans, then plans and applies Adopt for the findings whose real paths are given. */
  const adopt = async (...realPaths: string[]) => {
    await trpc.scan.run.mutate();
    const plan = await trpc.adopt.plan.mutate({ findings: realPaths.map((path) => `global-skill:${path}`) });
    await trpc.adopt.execute.mutate({ findings: plan.findings, planId: plan.planId });
    return plan;
  };
  return { home, libraryHome, trpc, fixture, adopt };
};

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("Adopt", () => {
  test("moves a Global Skill into the Library under local/<name>, with provenance in library-lock.json", async () => {
    const { fixture, home, libraryHome, trpc, adopt } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf", description: "Work with PDFs" }, "# hi\n");

    await adopt("~/.claude/skills/pdf");

    expect(await exists(join(home, ".claude/skills/pdf"))).toBe(false);
    expect(await readFile(join(libraryHome, "skills/local/pdf/SKILL.md"), "utf8")).toContain("Work with PDFs");
    const lock = await readJson(join(libraryHome, "library-lock.json"));
    expect(lock).toEqual({
      version: 1,
      skills: {
        "local/pdf": {
          source: "~/.claude/skills/pdf",
          sourceType: "local",
          computedHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          adoptedFrom: "~/.claude/skills/pdf",
        },
      },
    });
    expect((await trpc.library.list.query()).skills).toEqual([
      {
        key: "local/pdf",
        namespace: "local",
        name: "pdf",
        description: "Work with PDFs",
        localSource: null,
        adoptedFrom: "~/.claude/skills/pdf",
      },
    ]);
    expect((await trpc.inbox.list.query()).count).toBe(0);
  });

  test("takes the Namespace and provenance from the skills CLI's global lock, then removes its entry with a backup", async () => {
    const { fixture, home, libraryHome, adopt } = await setup();
    const skill = await fixture.skill(".agents/skills/find-skills", {}, "");
    // The skills CLI README's test vector: SKILL.md = "a\n", docs/b.md = "b\n".
    await writeFile(join(skill, "SKILL.md"), "a\n");
    await mkdir(join(skill, "docs"));
    await writeFile(join(skill, "docs/b.md"), "b\n");
    await fixture.globalLock({ "find-skills": { source: "vercel-labs/skills" }, other: { source: "acme/tools" } });
    const lockBefore = await readFile(join(home, ".agents/.skill-lock.json"), "utf8");

    const plan = await adopt("~/.agents/skills/find-skills");

    expect(plan.skills).toEqual([
      expect.objectContaining({
        key: "vercel-labs/skills/find-skills",
        namespace: "vercel-labs/skills",
        outcome: "moved",
      }),
    ]);
    expect(await exists(join(libraryHome, "skills/vercel-labs/skills/find-skills/docs/b.md"))).toBe(true);
    const lock = await readJson(join(libraryHome, "library-lock.json"));
    expect(lock.skills["vercel-labs/skills/find-skills"]).toEqual({
      source: "vercel-labs/skills",
      sourceType: "github",
      skillPath: "skills/find-skills/SKILL.md",
      computedHash: "b22c4d22aa319d2924312fa18fcbfedc88fa89c74dbd8f298c683e1caf7b7f24",
      adoptedFrom: "~/.agents/skills/find-skills",
      skillLockEntry: {
        path: "~/.agents/.skill-lock.json",
        name: "find-skills",
        entry: expect.objectContaining({ source: "vercel-labs/skills", installedAt: "2026-11-01T00:00:00.000Z" }),
      },
    });
    const globalLock = await readJson(join(home, ".agents/.skill-lock.json"));
    expect(Object.keys(globalLock.skills)).toEqual(["other"]);
    expect(globalLock.version).toBe(3);
    const backups = await readdir(join(libraryHome, "backups"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(libraryHome, "backups", backups[0] ?? ""), "utf8")).toBe(lockBefore);
  });

  test("moves a Skill's real folder once and removes every global symlink to it", async () => {
    const { fixture, home, libraryHome, trpc, adopt } = await setup();
    await fixture.skill(".agents/skills/pdf", { name: "pdf" });
    await fixture.link(".claude/skills/pdf", ".agents/skills/pdf");
    await fixture.link(".cursor/skills/pdf-again", ".claude/skills/pdf");

    await adopt("~/.agents/skills/pdf");

    for (const path of [".agents/skills/pdf", ".claude/skills/pdf", ".cursor/skills/pdf-again"]) {
      expect(await exists(join(home, path))).toBe(false);
    }
    expect((await lstat(join(libraryHome, "skills/local/pdf"))).isDirectory()).toBe(true);
    expect((await trpc.library.list.query()).skills.map((skill) => skill.key)).toEqual(["local/pdf"]);
  });

  test("merges identical copies into one Library Skill and removes every global copy", async () => {
    const { fixture, home, trpc, adopt } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf" });
    await fixture.skill(".codex/skills/pdf", { name: "pdf" });

    const plan = await adopt("~/.claude/skills/pdf", "~/.codex/skills/pdf");

    expect(plan.skills.map(({ key, outcome }) => ({ key, outcome }))).toEqual([
      { key: "local/pdf", outcome: "moved" },
      { key: "local/pdf", outcome: "merged" },
    ]);
    expect(await exists(join(home, ".claude/skills/pdf"))).toBe(false);
    expect(await exists(join(home, ".codex/skills/pdf"))).toBe(false);
    expect((await trpc.library.list.query()).skills.map((skill) => skill.key)).toEqual(["local/pdf"]);
  });

  test("merges a copy identical to a Skill already in the Library", async () => {
    const { fixture, home, trpc, adopt } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf" });
    await adopt("~/.claude/skills/pdf");
    await fixture.skill(".codex/skills/pdf", { name: "pdf" });

    const plan = await adopt("~/.codex/skills/pdf");

    expect(plan.skills).toEqual([expect.objectContaining({ key: "local/pdf", outcome: "merged" })]);
    expect(await exists(join(home, ".codex/skills/pdf"))).toBe(false);
    expect((await trpc.library.list.query()).skills).toHaveLength(1);
  });

  test("turns a global symlink to a folder outside every Agent folder into a Local Source, never moving it", async () => {
    const { fixture, home, libraryHome, trpc, adopt } = await setup();
    const source = await fixture.skill("code/my-skills/mine", { name: "mine", description: "My own" });
    await fixture.link(".claude/skills/mine", "code/my-skills/mine");

    const plan = await adopt("~/code/my-skills/mine");

    expect(plan.skills).toEqual([expect.objectContaining({ key: "local/mine", outcome: "localSource" })]);
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toContain("My own");
    expect(await exists(join(home, ".claude/skills/mine"))).toBe(false);
    expect(await readlink(join(libraryHome, "skills/local/mine"))).toBe(source);
    expect((await trpc.library.list.query()).skills).toEqual([
      expect.objectContaining({
        key: "local/mine",
        description: "My own",
        localSource: "~/code/my-skills/mine",
        adoptedFrom: "~/.claude/skills/mine",
      }),
    ]);
  });

  test("keeps same-name Skills with different content side by side as local/<name>-<shorthash>, with a diff", async () => {
    const { fixture, home, libraryHome, adopt } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf" }, "Use pdftk.\n");
    await fixture.skill(".codex/skills/pdf", { name: "pdf" }, "Use qpdf.\n");

    const plan = await adopt("~/.claude/skills/pdf", "~/.codex/skills/pdf");

    const [first, second] = plan.skills;
    expect(first).toMatchObject({ key: "local/pdf", outcome: "moved", diff: null });
    expect(second?.outcome).toBe("variant");
    expect(second?.key).toBe(`local/pdf-${second?.computedHash.slice(0, 7)}`);
    expect(second?.diff?.against).toBe("local/pdf");
    expect(second?.diff?.patch).toContain("-Use pdftk.\n+Use qpdf.");
    // Kept as is: the frontmatter isn't rewritten.
    expect(await readFile(join(libraryHome, "skills", ...(second?.key ?? "").split("/"), "SKILL.md"), "utf8")).toBe(
      '---\nname: "pdf"\n---\n\nUse qpdf.\n',
    );
    expect(await exists(join(home, ".claude/skills/pdf"))).toBe(false);
    expect(await exists(join(home, ".codex/skills/pdf"))).toBe(false);
  });

  test("puts same-name Skills from different Sources in their own Namespaces, with a diff", async () => {
    const { fixture, trpc, adopt } = await setup();
    await fixture.skill(".agents/skills/pdf", { name: "pdf" }, "From acme.\n");
    await fixture.skill(".claude/skills/pdf", { name: "pdf" }, "Hand made.\n");
    await fixture.globalLock({ pdf: { source: "acme/skills" } });

    const plan = await adopt("~/.agents/skills/pdf", "~/.claude/skills/pdf");

    expect(plan.skills.map(({ key, outcome, diff }) => ({ key, outcome, against: diff?.against ?? null }))).toEqual([
      { key: "acme/skills/pdf", outcome: "moved", against: null },
      { key: "local/pdf", outcome: "variant", against: "acme/skills/pdf" },
    ]);
    expect((await trpc.library.list.query()).skills.map((skill) => skill.key)).toEqual([
      "acme/skills/pdf",
      "local/pdf",
    ]);
  });

  test("the plan is a dry run: it writes nothing and warns that Agents stop seeing the Skills", async () => {
    const { fixture, home, trpc } = await setup();
    await fixture.skill(".agents/skills/pdf", { name: "pdf" });
    await fixture.link(".claude/skills/pdf", ".agents/skills/pdf");
    await fixture.skill(".codex/skills/docx", { name: "docx" });
    await fixture.globalLock({ pdf: { source: "acme/skills" } });
    await trpc.scan.run.mutate();
    const except = [".dark-matter/state", ".dark-matter/activity"];
    const before = await snapshotTree(home, except);

    const plan = await trpc.adopt.plan.mutate({
      findings: ["global-skill:~/.agents/skills/pdf", "global-skill:~/.codex/skills/docx"],
    });

    expect(await snapshotTree(home, except)).toEqual(before);
    expect(plan.warnings).toEqual([
      "These 2 Skills stop being visible to every Agent everywhere. Agents see a Library Skill again only when a Project adds it.",
    ]);
    expect(plan.steps).toEqual([
      { kind: "move", from: "~/.agents/skills/pdf", to: "~/.dark-matter/skills/acme/skills/pdf" },
      { kind: "move", from: "~/.codex/skills/docx", to: "~/.dark-matter/skills/local/docx" },
      {
        kind: "editFile",
        path: "~/.dark-matter/library-lock.json",
        change: "record provenance for acme/skills/pdf, local/docx",
      },
      { kind: "removeLink", path: "~/.claude/skills/pdf", target: join(home, ".agents/skills/pdf") },
      {
        kind: "editFile",
        path: "~/.agents/.skill-lock.json",
        change: "remove pdf",
        backup: expect.stringMatching(/^~\/\.dark-matter\/backups\/skill-lock\.[0-9a-f]{12}\.json$/),
      },
    ]);
  });

  test("refuses a plan that went stale between the dry run and applying it", async () => {
    const { fixture, home, trpc } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf" }, "One.\n");
    await trpc.scan.run.mutate();
    const plan = await trpc.adopt.plan.mutate({ findings: ["global-skill:~/.claude/skills/pdf"] });
    await writeFile(join(home, ".claude/skills/pdf/SKILL.md"), "Changed.\n");

    await expect(trpc.adopt.execute.mutate({ findings: plan.findings, planId: plan.planId })).rejects.toMatchObject({
      data: { tag: "PlanStale" },
    });
    expect(await readFile(join(home, ".claude/skills/pdf/SKILL.md"), "utf8")).toBe("Changed.\n");
  });

  test("rejects a finding the latest Scan doesn't have", async () => {
    const { trpc } = await setup();
    await trpc.scan.run.mutate();

    await expect(trpc.adopt.plan.mutate({ findings: ["global-skill:~/.claude/skills/nope"] })).rejects.toMatchObject({
      data: { tag: "FindingNotFound" },
    });
  });

  test("records the Adopt in the Activity Log with the files it wrote", async () => {
    const { fixture, trpc, adopt } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf" });

    await adopt("~/.claude/skills/pdf");

    const entry = (await trpc.activity.list.query()).entries.find((candidate) => candidate.action === "adopt.apply");
    expect(entry).toMatchObject({
      client: "app",
      result: "ok",
      subjects: [{ kind: "skill", id: "local/pdf" }],
      filesWritten: ["~/.dark-matter/skills/local/pdf", "~/.dark-matter/library-lock.json"],
    });
  });
});

describe("Adopt with a held hand edit", () => {
  test("moves nothing while library-lock.json holds an invalid hand edit", async () => {
    const { fixture, home, libraryHome, trpc } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf" });
    await writeFile(join(libraryHome, "library-lock.json"), "{ not json");
    await expect.poll(async () => (await trpc.ownedFiles.problems.query()).length).toBe(1);
    await trpc.scan.run.mutate();
    const plan = await trpc.adopt.plan.mutate({ findings: ["global-skill:~/.claude/skills/pdf"] });

    await expect(trpc.adopt.execute.mutate({ findings: plan.findings, planId: plan.planId })).rejects.toMatchObject({
      data: { tag: "InvalidOwnedFile" },
    });
    expect(await exists(join(home, ".claude/skills/pdf/SKILL.md"))).toBe(true);
  });
});

describe("Undo Adopt", () => {
  test("moves the folder back and puts back its symlinks, merged copies and global lock entry, never using trash/", async () => {
    const { fixture, home, libraryHome, trpc, adopt } = await setup();
    await fixture.skill(".agents/skills/pdf", { name: "pdf" });
    await fixture.link(".claude/skills/pdf", ".agents/skills/pdf");
    await fixture.skill(".codex/skills/pdf", { name: "pdf" });
    await fixture.globalLock({ pdf: { source: "acme/skills" }, other: { source: "acme/tools" } });
    const agentFolders = [".agents", ".claude", ".codex"];
    const before = Object.fromEntries(
      await Promise.all(agentFolders.map(async (folder) => [folder, await snapshotTree(join(home, folder))] as const)),
    );
    const contents = async () =>
      Object.fromEntries(
        await Promise.all(
          [".agents/skills/pdf/SKILL.md", ".claude/skills/pdf/SKILL.md", ".codex/skills/pdf/SKILL.md"].map(
            async (path) => [path, await readFile(join(home, path), "utf8")] as const,
          ),
        ),
      );
    const contentsBefore = await contents();
    const globalLockBefore = await readJson(join(home, ".agents/.skill-lock.json"));
    await adopt("~/.agents/skills/pdf", "~/.codex/skills/pdf");

    await trpc.adopt.undo.mutate({ key: "acme/skills/pdf" });

    expect(await contents()).toEqual(contentsBefore);
    expect(await readlink(join(home, ".claude/skills/pdf"))).toBe(join(home, ".agents/skills/pdf"));
    expect((await lstat(join(home, ".codex/skills/pdf"))).isDirectory()).toBe(true);
    expect(await readJson(join(home, ".agents/.skill-lock.json"))).toEqual(globalLockBefore);
    expect(Object.keys(await snapshotTree(join(home, ".claude")))).toEqual(Object.keys(before[".claude"] ?? {}));
    expect(Object.keys(await snapshotTree(join(home, ".codex")))).toEqual(Object.keys(before[".codex"] ?? {}));
    expect(await exists(join(libraryHome, "skills/acme/skills/pdf"))).toBe(false);
    expect(await exists(join(libraryHome, "trash"))).toBe(false);
    expect((await readJson(join(libraryHome, "library-lock.json"))).skills).toEqual({});
    expect((await trpc.library.list.query()).skills).toEqual([]);
    expect((await trpc.inbox.list.query()).count).toBe(2);
  });

  test("removes only the Library's symlink to a Local Source and puts the global symlink back", async () => {
    const { fixture, home, libraryHome, trpc, adopt } = await setup();
    const source = await fixture.skill("code/my-skills/mine", { name: "mine" });
    await fixture.link(".claude/skills/mine", "code/my-skills/mine");
    await adopt("~/code/my-skills/mine");

    await trpc.adopt.undo.mutate({ key: "local/mine" });

    expect(await readlink(join(home, ".claude/skills/mine"))).toBe(source);
    expect(await exists(join(source, "SKILL.md"))).toBe(true);
    expect(await exists(join(libraryHome, "skills/local/mine"))).toBe(false);
  });

  test("refuses to overwrite something that now sits where the Skill came from", async () => {
    const { fixture, home, trpc, adopt } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf" }, "Old.\n");
    await adopt("~/.claude/skills/pdf");
    await fixture.skill(".claude/skills/pdf", { name: "pdf" }, "New.\n");

    await expect(trpc.adopt.undo.mutate({ key: "local/pdf" })).rejects.toMatchObject({ data: { tag: "PathTaken" } });
    expect(await readFile(join(home, ".claude/skills/pdf/SKILL.md"), "utf8")).toContain("New.");
    expect((await trpc.library.list.query()).skills).toHaveLength(1);
  });

  test("checks every target before moving anything", async () => {
    const { fixture, home, libraryHome, trpc, adopt } = await setup();
    await fixture.skill(".agents/skills/pdf", { name: "pdf" });
    await fixture.link(".claude/skills/pdf", ".agents/skills/pdf");
    await adopt("~/.agents/skills/pdf");
    await fixture.skill(".claude/skills/pdf", { name: "someone else's" });

    await expect(trpc.adopt.undo.mutate({ key: "local/pdf" })).rejects.toMatchObject({ data: { tag: "PathTaken" } });
    expect(await exists(join(home, ".agents/skills/pdf"))).toBe(false);
    expect(await exists(join(libraryHome, "skills/local/pdf/SKILL.md"))).toBe(true);
  });
});
