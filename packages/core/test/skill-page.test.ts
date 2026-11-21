import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentHome } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

const setup = async () => {
  const { home, libraryHome } = await tempHome();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  const { trpc } = connect(core);
  const fixture = agentHome(home);
  const adopt = async (...realPaths: string[]) => {
    await trpc.scan.run.mutate();
    const plan = await trpc.adopt.plan.query({ findings: realPaths.map((path) => `global-skill:${path}`) });
    await trpc.adopt.execute.mutate({ findings: plan.findings, planId: plan.planId });
  };
  return { home, libraryHome, trpc, fixture, adopt };
};

describe("Skill page", () => {
  test("reads a Library Skill: SKILL.md split into frontmatter and body, its Library Lock entry and folder", async () => {
    const { fixture, libraryHome, trpc, adopt } = await setup();
    await fixture.skill(".agents/skills/find-skills", { name: "find-skills", description: "Find Skills" }, "# Find\n");
    await fixture.globalLock({ "find-skills": { source: "vercel-labs/skills" } });
    await adopt("~/.agents/skills/find-skills");

    const skill = await trpc.skill.get.query({ key: "vercel-labs/skills/find-skills" });

    expect(skill).toEqual({
      key: "vercel-labs/skills/find-skills",
      namespace: "vercel-labs/skills",
      name: "find-skills",
      path: join(libraryHome, "skills/vercel-labs/skills/find-skills"),
      frontmatter: 'name: "find-skills"\ndescription: "Find Skills"',
      body: "\n# Find\n",
      warnings: [],
      entry: expect.objectContaining({
        source: "vercel-labs/skills",
        sourceType: "github",
        skillPath: "skills/find-skills/SKILL.md",
        adoptedFrom: "~/.agents/skills/find-skills",
      }),
    });
  });

  test("warns about a missing description and a name that isn't valid or doesn't match the folder", async () => {
    const { fixture, trpc, adopt } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "PDF Tools" });
    await fixture.file(".claude/skills/bare/SKILL.md", "# No frontmatter\n");
    await adopt("~/.claude/skills/pdf", "~/.claude/skills/bare");

    const pdf = await trpc.skill.get.query({ key: "local/pdf" });
    expect(pdf.warnings).toEqual([
      { field: "name", message: expect.stringContaining("lowercase") },
      { field: "name", message: "name doesn't match the folder name pdf" },
      { field: "description", message: "description is missing" },
    ]);

    const bare = await trpc.skill.get.query({ key: "local/bare" });
    expect(bare.frontmatter).toBeNull();
    expect(bare.body).toBe("# No frontmatter\n");
    expect(bare.warnings).toEqual([
      { field: "name", message: "name is missing" },
      { field: "description", message: "description is missing" },
    ]);
  });

  test("an unknown key is SkillNotFound", async () => {
    const { trpc } = await setup();
    await expect(trpc.skill.get.query({ key: "local/nope" })).rejects.toMatchObject({
      data: { tag: "SkillNotFound" },
    });
  });
});

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe("Rename Namespace", () => {
  test("moves every Skill folder to the new Namespace and re-keys the Library Lock, keeping provenance", async () => {
    const { fixture, home, libraryHome, trpc, adopt } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf", description: "PDFs" });
    await fixture.skill(".claude/skills/docx", { name: "docx", description: "Word" });
    await adopt("~/.claude/skills/pdf", "~/.claude/skills/docx");
    const before = (await trpc.skill.get.query({ key: "local/pdf" })).entry;

    const plan = await trpc.namespace.plan.query({ from: "local", to: "acme/tools" });
    expect(plan.renames).toEqual([
      { from: "local/docx", to: "acme/tools/docx" },
      { from: "local/pdf", to: "acme/tools/pdf" },
    ]);
    expect(plan.steps).toEqual([
      { kind: "move", from: "~/.dark-matter/skills/local/docx", to: "~/.dark-matter/skills/acme/tools/docx" },
      { kind: "move", from: "~/.dark-matter/skills/local/pdf", to: "~/.dark-matter/skills/acme/tools/pdf" },
      {
        kind: "editFile",
        path: "~/.dark-matter/library-lock.json",
        change: "rename local/docx → acme/tools/docx, local/pdf → acme/tools/pdf",
      },
    ]);
    await trpc.namespace.rename.mutate({ from: "local", to: "acme/tools", planId: plan.planId });

    expect(await readFile(join(libraryHome, "skills/acme/tools/pdf/SKILL.md"), "utf8")).toContain("PDFs");
    expect(await exists(join(libraryHome, "skills/local"))).toBe(false);
    const lock = JSON.parse(await readFile(join(libraryHome, "library-lock.json"), "utf8"));
    expect(Object.keys(lock.skills)).toEqual(["acme/tools/docx", "acme/tools/pdf"]);
    expect(lock.skills["acme/tools/pdf"]).toEqual(before);
    expect((await trpc.library.list.query()).skills.map((skill) => skill.key)).toEqual([
      "acme/tools/docx",
      "acme/tools/pdf",
    ]);
    const [entry] = (await trpc.activity.list.query({})).entries;
    expect(entry).toMatchObject({ action: "namespace.rename", result: "ok" });
    expect(entry?.subjects).toContainEqual({ kind: "skill", id: "acme/tools/pdf" });

    // Undo Adopt still finds the Skill under its new key and moves it home.
    await trpc.adopt.undo.mutate({ key: "acme/tools/pdf" });
    expect(await readFile(join(home, ".claude/skills/pdf/SKILL.md"), "utf8")).toContain("PDFs");
  });

  test("moves a Local Source's Library symlink, still pointing at the folder it's authored in", async () => {
    const { fixture, libraryHome, trpc, adopt } = await setup();
    const source = await fixture.skill("code/mine", { name: "mine", description: "Mine" });
    await fixture.link(".claude/skills/mine", "code/mine");
    await adopt("~/code/mine");

    const plan = await trpc.namespace.plan.query({ from: "local", to: "me/kit" });
    await trpc.namespace.rename.mutate({ from: "local", to: "me/kit", planId: plan.planId });

    expect(await readlink(join(libraryHome, "skills/me/kit/mine"))).toBe(source);
    expect((await trpc.skill.get.query({ key: "me/kit/mine" })).entry.localSource).toBe("~/code/mine");
  });

  test("refuses a Namespace that would put two Skills under one key, and changes nothing", async () => {
    const { fixture, libraryHome, trpc, adopt } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf", description: "One" });
    await fixture.skill(".agents/skills/pdf", { name: "pdf", description: "Two" });
    await fixture.globalLock({ pdf: { source: "acme/tools" } });
    await adopt("~/.claude/skills/pdf", "~/.agents/skills/pdf");
    const lockBefore = await readFile(join(libraryHome, "library-lock.json"), "utf8");

    await expect(trpc.namespace.plan.query({ from: "local", to: "acme/tools" })).rejects.toMatchObject({
      data: { tag: "NameConflict" },
    });
    expect(await readFile(join(libraryHome, "library-lock.json"), "utf8")).toBe(lockBefore);
  });

  test("an unknown Namespace, an invalid name and a stale plan are refused", async () => {
    const { fixture, trpc, adopt } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf", description: "PDFs" });
    await adopt("~/.claude/skills/pdf");

    await expect(trpc.namespace.plan.query({ from: "nobody/here", to: "a/b" })).rejects.toMatchObject({
      data: { tag: "NamespaceNotFound" },
    });
    await expect(trpc.namespace.plan.query({ from: "local", to: "not a namespace" })).rejects.toMatchObject({
      data: { code: "BAD_REQUEST" },
    });
    await expect(trpc.namespace.rename.mutate({ from: "local", to: "a/b", planId: "stale" })).rejects.toMatchObject({
      data: { tag: "PlanStale" },
    });
  });
});
