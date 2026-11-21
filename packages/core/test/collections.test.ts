import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { agentHome, gitRepo } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

/** Library Skills written before the core starts: folders under `skills/` plus their Library Lock entries. */
const seedLibrary = async (libraryHome: string, skills: Record<string, { name?: string }>) => {
  const fixture = agentHome(libraryHome);
  const entries: Record<string, unknown> = {};
  for (const [key, frontmatter] of Object.entries(skills)) {
    await fixture.skill(join(libraryHome, "skills", key), { description: `About ${key}`, ...frontmatter });
    entries[key] = { source: key, sourceType: "local", computedHash: "0".repeat(64) };
  }
  await mkdir(libraryHome, { recursive: true });
  await writeFile(join(libraryHome, "library-lock.json"), JSON.stringify({ version: 1, skills: entries }));
};

const setup = async (skills: Record<string, { name?: string }> = { "local/pdf": {}, "local/docx": {} }) => {
  const { home, libraryHome } = await tempHome();
  await seedLibrary(libraryHome, skills);
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  const { trpc } = connect(core);
  const project = async (dir: string, agents: AgentId[] = ["claude-code"]) => {
    const path = await gitRepo(home, dir);
    await trpc.project.add.mutate({ path, agents });
    return path;
  };
  const settings = async () => JSON.parse(await readFile(join(libraryHome, "settings.json"), "utf8"));
  return { home, libraryHome, trpc, project, settings, fixture: agentHome(home) };
};

const linkAt = (path: string) =>
  lstat(path).then(
    async (info) => (info.isSymbolicLink() ? readlink(path) : `not a symlink (${info.isDirectory() ? "dir" : "file"})`),
    () => null,
  );

const skill = (key: string) => ({ kind: "skill" as const, key });

describe("Collections", () => {
  test("creating one stores a named, flat list of Library Skills in settings.json", async () => {
    const { trpc, settings } = await setup();

    await trpc.collections.create.mutate({ name: "docs kit", items: [skill("local/pdf"), skill("local/docx")] });

    expect((await settings()).collections).toEqual({
      "docs kit": { items: [skill("local/pdf"), skill("local/docx")] },
    });
    expect(await trpc.collections.list.query()).toEqual([
      {
        name: "docs kit",
        items: [
          { kind: "skill", key: "local/pdf", name: "pdf", missing: false },
          { kind: "skill", key: "local/docx", name: "docx", missing: false },
        ],
      },
    ]);
  });

  test("rename, edit and delete change settings.json; a taken name or an unknown Collection is refused", async () => {
    const { trpc, settings } = await setup();
    await trpc.collections.create.mutate({ name: "docs", items: [skill("local/pdf")] });
    await trpc.collections.create.mutate({ name: "other" });

    await expect(trpc.collections.create.mutate({ name: "docs" })).rejects.toMatchObject({
      data: { tag: "CollectionExists" },
    });
    await expect(trpc.collections.rename.mutate({ name: "docs", newName: "other" })).rejects.toMatchObject({
      data: { tag: "CollectionExists" },
    });

    await trpc.collections.rename.mutate({ name: "docs", newName: "docs kit" });
    const edited = await trpc.collections.setItems.mutate({
      name: "docs kit",
      items: [skill("local/docx"), skill("local/pdf"), skill("local/docx")],
    });

    expect(edited.items.map((item) => (item.kind === "skill" ? item.key : item.name))).toEqual([
      "local/docx",
      "local/pdf",
    ]);
    expect((await settings()).collections).toEqual({
      "docs kit": { items: [skill("local/docx"), skill("local/pdf")] },
      other: { items: [] },
    });

    await trpc.collections.delete.mutate({ name: "other" });

    expect(Object.keys((await settings()).collections)).toEqual(["docs kit"]);
    await expect(trpc.collections.delete.mutate({ name: "other" })).rejects.toMatchObject({
      data: { tag: "CollectionNotFound" },
    });
    const actions = (await trpc.activity.list.query({})).entries.map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "collections.create",
        "collections.rename",
        "collections.setItems",
        "collections.delete",
      ]),
    );
  });

  test("adding one to Projects creates ordinary Project Skills, Link or Copy per item, and later edits to the Collection don't touch them", async () => {
    const { libraryHome, trpc, project } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    const api = await project("code/api", ["claude-code"]);
    await trpc.collections.create.mutate({ name: "docs", items: [skill("local/pdf"), skill("local/docx")] });

    const plan = await trpc.collections.plan.query({
      name: "docs",
      projects: [app, api],
      modes: { "local/docx": "copy" },
    });

    const cell = (path: string, key: string, mode: string) => ({
      path,
      key,
      mode,
      outcome: "add",
      conflictsWith: [],
      blockedBy: null,
    });
    expect(plan.cells).toEqual([
      cell(app, "local/pdf", "link"),
      cell(app, "local/docx", "copy"),
      cell(api, "local/pdf", "link"),
      cell(api, "local/docx", "copy"),
    ]);
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBeNull();

    const applied = await trpc.collections.execute.mutate({
      name: "docs",
      skills: [
        { path: app, key: "local/pdf" },
        { path: app, key: "local/docx", mode: "copy" },
        { path: api, key: "local/pdf" },
      ],
    });

    expect(applied.cells).toEqual([
      cell(app, "local/pdf", "link"),
      cell(app, "local/docx", "copy"),
      cell(api, "local/pdf", "link"),
    ]);
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
    expect(await linkAt(join(app, ".agents/skills/docx"))).toBe("not a symlink (dir)");
    expect(JSON.parse(await readFile(join(app, "skills-lock.json"), "utf8")).skills).toHaveProperty("docx");
    const projectsJson = async () => JSON.parse(await readFile(join(libraryHome, "projects.json"), "utf8"));
    const before = await projectsJson();
    expect(before.projects[app].skills).toEqual({
      "local/docx": { mode: "copy", on: true },
      "local/pdf": { mode: "link", on: true },
    });
    expect(before.projects[api].skills).toEqual({ "local/pdf": { mode: "link", on: true } });

    await trpc.collections.setItems.mutate({ name: "docs", items: [skill("local/docx")] });
    await trpc.collections.delete.mutate({ name: "docs" });

    expect(await projectsJson()).toEqual(before);
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
    const [entry] = (await trpc.activity.list.query({ actions: ["collections.apply"] })).entries;
    expect(entry?.subjects).toEqual(
      expect.arrayContaining([
        { kind: "collection", id: "docs" },
        { kind: "project", id: app },
        { kind: "skill", id: "local/docx" },
      ]),
    );
  });

  test("Name Conflicts surface per item: one blocked item is skipped while the rest are added", async () => {
    const { trpc, project, fixture } = await setup({
      "local/pdf": {},
      "acme/pdf": { name: "pdf" },
      "local/docx": {},
      "local/xlsx": {},
    });
    const app = await project("code/app", ["claude-code"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });
    // A folder Dark Matter didn't put there, where docx would go.
    await fixture.skill(join(app, ".claude/skills/docx"), { name: "docx", description: "hand-made" });
    await trpc.collections.create.mutate({
      name: "kit",
      items: [skill("local/pdf"), skill("acme/pdf"), skill("local/docx"), skill("local/xlsx"), skill("local/gone")],
    });

    const plan = await trpc.collections.plan.query({ name: "kit", projects: [app] });

    const outcomes = plan.cells.map(({ key, outcome, conflictsWith, blockedBy }) => ({
      key,
      outcome,
      conflictsWith,
      blockedBy,
    }));
    const expected = [
      { key: "local/pdf", outcome: "present", conflictsWith: [], blockedBy: null },
      { key: "acme/pdf", outcome: "nameConflict", conflictsWith: ["local/pdf"], blockedBy: null },
      { key: "local/docx", outcome: "blocked", conflictsWith: [], blockedBy: ".claude/skills/docx" },
      { key: "local/xlsx", outcome: "add", conflictsWith: [], blockedBy: null },
      { key: "local/gone", outcome: "missing", conflictsWith: [], blockedBy: null },
    ];
    expect(outcomes).toEqual(expected);

    const applied = await trpc.collections.execute.mutate({
      name: "kit",
      skills: ["acme/pdf", "local/docx", "local/xlsx", "local/gone"].map((key) => ({ path: app, key })),
    });

    expect(applied.cells.map((cell) => [cell.key, cell.outcome])).toEqual([
      ["acme/pdf", "nameConflict"],
      ["local/docx", "blocked"],
      ["local/xlsx", "add"],
      ["local/gone", "missing"],
    ]);
    const skills = await trpc.project.skills.query({ path: app });
    expect(skills.map(({ key, status }) => [key, status])).toEqual([
      ["acme/pdf", "nameConflict"],
      ["local/pdf", "nameConflict"],
      ["local/xlsx", "on"],
    ]);
    expect(await linkAt(join(app, ".claude/skills/docx"))).toBe("not a symlink (dir)");
  });

  test("renaming a Namespace re-keys its Skills in every Collection; a deleted Skill shows as missing", async () => {
    const { trpc, settings } = await setup();
    await trpc.collections.create.mutate({ name: "docs", items: [skill("local/pdf"), skill("local/docx")] });

    const plan = await trpc.namespace.plan.query({ from: "local", to: "me/mine" });
    expect(plan.steps).toContainEqual({
      kind: "editFile",
      path: "~/.dark-matter/settings.json",
      change: "re-key renamed Skills in 1 Collection",
    });
    await trpc.namespace.rename.mutate({ from: "local", to: "me/mine", planId: plan.planId });

    expect((await settings()).collections.docs.items).toEqual([skill("me/mine/pdf"), skill("me/mine/docx")]);

    await trpc.skill.delete.mutate({ key: "me/mine/pdf" });

    expect((await trpc.collections.list.query())[0]?.items).toEqual([
      { kind: "skill", key: "me/mine/pdf", name: "pdf", missing: true },
      { kind: "skill", key: "me/mine/docx", name: "docx", missing: false },
    ]);
  });
});
