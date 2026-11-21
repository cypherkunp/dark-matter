import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { agentHome, gitRepo, snapshotTree } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

interface SeedSkill {
  name?: string;
  /** The Library Lock entry; a local one by default. */
  entry?: Record<string, unknown>;
  files?: Record<string, string>;
}

/** Library Skills written before the core starts: folders under `skills/` plus their Library Lock entries. */
const seedLibrary = async (libraryHome: string, skills: Record<string, SeedSkill>) => {
  const fixture = agentHome(libraryHome);
  const entries: Record<string, unknown> = {};
  for (const [key, { name, entry, files }] of Object.entries(skills)) {
    const folder = join(libraryHome, "skills", key);
    await fixture.skill(folder, { description: `About ${key}`, ...(name && { name }) });
    for (const [path, text] of Object.entries(files ?? {})) {
      await mkdir(join(folder, path, ".."), { recursive: true });
      await writeFile(join(folder, path), text);
    }
    entries[key] = entry ?? { source: "/somewhere", sourceType: "local", computedHash: "0".repeat(64) };
  }
  await mkdir(libraryHome, { recursive: true });
  await writeFile(join(libraryHome, "library-lock.json"), JSON.stringify({ version: 1, skills: entries }));
};

const PDF_ENTRY = {
  source: "acme/skills",
  sourceType: "github",
  ref: "main",
  commit: "1111111111111111111111111111111111111111",
  skillPath: "skills/pdf/SKILL.md",
  computedHash: "0".repeat(64),
};

const setup = async (
  skills: Record<string, SeedSkill> = { "acme/skills/pdf": { entry: PDF_ENTRY } },
  before?: (home: string) => Promise<void>,
) => {
  const { home, libraryHome } = await tempHome();
  await seedLibrary(libraryHome, skills);
  await before?.(home);
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  const { trpc } = connect(core);
  /** A git repo confirmed as a Project with these Agents. */
  const project = async (dir: string, agents: AgentId[]) => {
    const path = await gitRepo(home, dir);
    await trpc.project.add.mutate({ path, agents });
    return path;
  };
  return { home, libraryHome, trpc, project, fixture: agentHome(home) };
};

const linkAt = (path: string) =>
  lstat(path).then(
    async (info) => (info.isSymbolicLink() ? readlink(path) : `not a symlink (${info.isDirectory() ? "dir" : "file"})`),
    () => null,
  );
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );
const symlinkRel = (path: string, target: string) => symlink(target, path, "dir");
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

describe("Project Skills as Copies", () => {
  test("a Copy is a real folder in .agents/skills, a relative .claude/skills symlink, and a skills-lock.json entry the way the skills CLI writes it", async () => {
    const { libraryHome, trpc, project } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);

    const [added] = await trpc.project.addSkills.mutate({
      skills: [{ path: app, key: "acme/skills/pdf", mode: "copy" }],
    });

    const copy = join(app, ".agents/skills/pdf");
    expect((await lstat(copy)).isDirectory()).toBe(true);
    expect(await readFile(join(copy, "SKILL.md"), "utf8")).toBe(
      await readFile(join(libraryHome, "skills/acme/skills/pdf/SKILL.md"), "utf8"),
    );
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe("../../.agents/skills/pdf");
    // The hash is the skills CLI's computedHash of the Copy (checked against the CLI's README vectors in skill-hash).
    const { computeSkillFolderHash } = await import("../src/skill-hash");
    const hash = await computeSkillFolderHash(copy);
    expect(await readFile(join(app, "skills-lock.json"), "utf8")).toBe(
      `${JSON.stringify(
        {
          version: 2,
          skills: {
            pdf: {
              source: "acme/skills",
              ref: "main",
              commit: "1111111111111111111111111111111111111111",
              sourceType: "github",
              skillPath: "skills/pdf/SKILL.md",
              computedHash: hash,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    // Committed, so not excluded from git.
    expect(await readFile(join(app, ".git/info/exclude"), "utf8")).not.toContain("pdf");
    expect((await readJson(join(libraryHome, "projects.json"))).projects[app].skills).toEqual({
      "acme/skills/pdf": { mode: "copy", on: true },
    });
    expect(added?.skills).toEqual([
      expect.objectContaining({ key: "acme/skills/pdf", mode: "copy", status: "on", copyState: "current" }),
    ]);
  });

  test("a Copy not committed yet isn't offered as an untracked Project Skill", async () => {
    const { trpc, project } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "acme/skills/pdf", mode: "copy" }] });
    await trpc.scan.run.mutate();
    expect((await trpc.inbox.list.query()).untrackedSkills).toEqual([]);
  });

  test("Off removes the Copy folder, its symlink and its lock entry; On restores both from the Library", async () => {
    const { trpc, project } = await setup({
      "acme/skills/pdf": { entry: PDF_ENTRY },
      "local/notes": {},
    });
    const app = await project("code/app", ["claude-code", "cursor"]);
    await trpc.project.addSkills.mutate({
      skills: [
        { path: app, key: "acme/skills/pdf", mode: "copy" },
        { path: app, key: "local/notes", mode: "copy" },
      ],
    });
    const lockWithBoth = await readFile(join(app, "skills-lock.json"), "utf8");
    expect(Object.keys(JSON.parse(lockWithBoth).skills)).toEqual(["notes", "pdf"]);
    expect(JSON.parse(lockWithBoth).skills.notes).toEqual({
      source: "./.agents/skills/notes",
      sourceType: "local",
      computedHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const off = await trpc.project.setSkillOn.mutate({ path: app, key: "acme/skills/pdf", on: false });
    expect(await exists(join(app, ".agents/skills/pdf"))).toBe(false);
    expect(await exists(join(app, ".claude/skills/pdf"))).toBe(false);
    expect(Object.keys((await readJson(join(app, "skills-lock.json"))).skills)).toEqual(["notes"]);
    expect(off.skills.find((skill) => skill.key === "acme/skills/pdf")).toMatchObject({ status: "off", mode: "copy" });

    await trpc.project.setSkillOn.mutate({ path: app, key: "acme/skills/pdf", on: true });
    expect(await readFile(join(app, "skills-lock.json"), "utf8")).toBe(lockWithBoth);
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe("../../.agents/skills/pdf");

    await trpc.project.removeSkill.mutate({ path: app, key: "local/notes" });
    expect(await exists(join(app, ".agents/skills/notes"))).toBe(false);
    expect(Object.keys((await readJson(join(app, "skills-lock.json"))).skills)).toEqual(["pdf"]);
  });

  test("a Copy for Claude Code alone is still a real folder in .agents/skills with the .claude/skills symlink", async () => {
    const { trpc, project } = await setup();
    const app = await project("code/app", ["claude-code"]);
    const [added] = await trpc.project.addSkills.mutate({
      skills: [{ path: app, key: "acme/skills/pdf", mode: "copy" }],
    });
    expect((await lstat(join(app, ".agents/skills/pdf"))).isDirectory()).toBe(true);
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe("../../.agents/skills/pdf");
    expect(added?.skills[0]?.paths).toEqual([".agents/skills/pdf", ".claude/skills/pdf"]);

    // Dropping Claude Code removes only its symlink.
    await trpc.project.setAgents.mutate({ path: app, agents: ["codex"] });
    expect(await exists(join(app, ".claude/skills/pdf"))).toBe(false);
    expect((await lstat(join(app, ".agents/skills/pdf"))).isDirectory()).toBe(true);
  });

  test("a Copy edited in the repo is 'modified in repo' and never overwritten or removed without asking", async () => {
    const { trpc, project } = await setup();
    const app = await project("code/app", ["codex"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "acme/skills/pdf", mode: "copy" }] });
    await writeFile(join(app, ".agents/skills/pdf/notes.md"), "a teammate's fix\n");
    const before = await snapshotTree(app);

    expect((await trpc.project.skills.query({ path: app }))[0]?.copyState).toBe("modifiedInRepo");
    await expect(
      trpc.project.setSkillOn.mutate({ path: app, key: "acme/skills/pdf", on: false }),
    ).rejects.toMatchObject({
      data: { tag: "CopyModifiedInRepo" },
    });
    await expect(trpc.project.removeSkill.mutate({ path: app, key: "acme/skills/pdf" })).rejects.toMatchObject({
      data: { tag: "CopyModifiedInRepo" },
    });
    await expect(trpc.project.updateCopy.mutate({ path: app, key: "acme/skills/pdf" })).rejects.toMatchObject({
      data: { tag: "CopyModifiedInRepo" },
    });
    expect(await snapshotTree(app)).toEqual(before);

    // Asked: Take Library version.
    const taken = await trpc.project.updateCopy.mutate({ path: app, key: "acme/skills/pdf", discardEdits: true });
    expect(await exists(join(app, ".agents/skills/pdf/notes.md"))).toBe(false);
    expect(taken.skills[0]?.copyState).toBe("current");
  });

  test("Resolve never deletes a Copy edited in the repo without asking (story 63)", async () => {
    const { trpc, project } = await setup({
      "acme/skills/pdf": { entry: PDF_ENTRY },
      "local/pdf": { name: "pdf" },
    });
    const app = await project("code/app", ["codex"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "acme/skills/pdf", mode: "copy" }] });
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });
    await writeFile(join(app, ".agents/skills/pdf/notes.md"), "a teammate's fix\n");
    const before = await snapshotTree(app);

    await expect(trpc.project.resolveConflict.mutate({ path: app, key: "local/pdf" })).rejects.toMatchObject({
      data: { tag: "CopyModifiedInRepo" },
    });
    expect(await snapshotTree(app)).toEqual(before);

    const resolved = await trpc.project.resolveConflict.mutate({ path: app, key: "local/pdf", discardEdits: true });
    expect(resolved.skills.map((skill) => skill.key)).toEqual(["local/pdf"]);
    expect(await exists(join(app, ".agents/skills/pdf/notes.md"))).toBe(false);
  });

  test("a Copy is 'outdated' when the Library moves on; Update brings the files and the lock entry up to date", async () => {
    const { libraryHome, trpc, project } = await setup();
    const app = await project("code/app", ["codex"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "acme/skills/pdf", mode: "copy" }] });
    const oldLock = await readJson(join(app, "skills-lock.json"));
    await writeFile(join(libraryHome, "skills/acme/skills/pdf/extra.md"), "new upstream file\n");

    expect((await trpc.project.skills.query({ path: app }))[0]?.copyState).toBe("outdated");
    const updated = await trpc.project.updateCopy.mutate({ path: app, key: "acme/skills/pdf" });
    expect(updated.skills[0]?.copyState).toBe("current");
    expect(await readFile(join(app, ".agents/skills/pdf/extra.md"), "utf8")).toBe("new upstream file\n");
    const newLock = await readJson(join(app, "skills-lock.json"));
    expect(newLock.skills.pdf.computedHash).not.toBe(oldLock.skills.pdf.computedHash);
  });

  test("Diff shows a modified-in-repo Copy's edits; Pull into Library copies them in and marks a Skill with a Source Modified", async () => {
    const { libraryHome, trpc, project } = await setup();
    const app = await project("code/app", ["codex"]);
    const other = await project("code/other", ["codex"]);
    await trpc.project.addSkills.mutate({
      skills: [
        { path: app, key: "acme/skills/pdf", mode: "copy" },
        { path: other, key: "acme/skills/pdf", mode: "copy" },
      ],
    });
    await writeFile(join(app, ".agents/skills/pdf/notes.md"), "a teammate's fix\n");

    const { patch } = await trpc.project.copyDiff.query({ path: app, key: "acme/skills/pdf" });
    expect(patch).toContain("+a teammate's fix");
    expect(patch).toContain("notes.md");

    const pulled = await trpc.project.pullCopy.mutate({ path: app, key: "acme/skills/pdf" });
    expect(pulled.skills[0]?.copyState).toBe("current");
    expect(await readFile(join(libraryHome, "skills/acme/skills/pdf/notes.md"), "utf8")).toBe("a teammate's fix\n");
    const lockEntry = (await readJson(join(app, "skills-lock.json"))).skills.pdf;
    const { computeSkillFolderHash } = await import("../src/skill-hash");
    expect(lockEntry.computedHash).toBe(await computeSkillFolderHash(join(app, ".agents/skills/pdf")));
    // The Library moved on, so the other Project's Copy is now outdated.
    expect((await trpc.project.skills.query({ path: other }))[0]?.copyState).toBe("outdated");
    const { skills } = await trpc.library.list.query();
    expect(skills.find((skill) => skill.key === "acme/skills/pdf")?.modified).toBe(true);
  });

  test("Pull into Library for a local Skill (no Source) doesn't mark it Modified", async () => {
    const { libraryHome, trpc, project } = await setup({ "local/notes": {} });
    const app = await project("code/app", ["codex"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/notes", mode: "copy" }] });
    await writeFile(join(app, ".agents/skills/notes/extra.md"), "more\n");
    await trpc.project.pullCopy.mutate({ path: app, key: "local/notes" });
    expect(await readFile(join(libraryHome, "skills/local/notes/extra.md"), "utf8")).toBe("more\n");
    expect((await trpc.library.list.query()).skills[0]?.modified).toBeFalsy();
  });

  test("switching a Link to a Copy (and back) swaps the delivery; a modified Copy isn't switched without asking", async () => {
    const { libraryHome, trpc, project } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "acme/skills/pdf" }] });
    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBe(join(libraryHome, "skills/acme/skills/pdf"));

    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "acme/skills/pdf", mode: "copy" }] });
    expect((await lstat(join(app, ".agents/skills/pdf"))).isDirectory()).toBe(true);
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe("../../.agents/skills/pdf");
    expect(await readFile(join(app, ".git/info/exclude"), "utf8")).not.toContain("pdf");

    await writeFile(join(app, ".agents/skills/pdf/notes.md"), "edit\n");
    await expect(
      trpc.project.addSkills.mutate({ skills: [{ path: app, key: "acme/skills/pdf", mode: "link" }] }),
    ).rejects.toMatchObject({ data: { tag: "CopyModifiedInRepo" } });
    await rm(join(app, ".agents/skills/pdf/notes.md"));
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "acme/skills/pdf", mode: "link" }] });
    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBe(join(libraryHome, "skills/acme/skills/pdf"));
    expect((await readJson(join(app, "skills-lock.json"))).skills).toEqual({});
  });
});

describe("Vendored Skills and an existing skills-lock.json", () => {
  /** A teammate's repo: a committed Skill with a lock entry, a committed one without, and an untracked one. */
  const teamRepo = async (home: string, fixture: ReturnType<typeof agentHome>) => {
    const app = await gitRepo(home, "code/team");
    await fixture.skill(join(app, ".agents/skills/pdf"), { name: "pdf", description: "About acme/skills/pdf" });
    await fixture.skill(join(app, ".agents/skills/houserules"), { name: "houserules", description: "Our rules" });
    await mkdir(join(app, ".claude/skills"), { recursive: true });
    await symlinkRel(join(app, ".claude/skills/houserules"), "../../.agents/skills/houserules");
    await fixture.skill(join(app, ".agents/skills/scratch"), { name: "scratch", description: "Not committed" });
    await fixture.skill(join(app, ".agents/skills/zip"), { name: "zip", description: "Wanted from elsewhere" });
    const { computeSkillFolderHash } = await import("../src/skill-hash");
    const lock = {
      version: 2,
      skills: {
        pdf: { ...PDF_ENTRY, computedHash: await computeSkillFolderHash(join(app, ".agents/skills/pdf")) },
        missing: {
          source: "acme/skills",
          sourceType: "github",
          skillPath: "skills/missing/SKILL.md",
          computedHash: "",
        },
        zip: { source: "someone/else", sourceType: "github", computedHash: "" },
      },
    };
    await writeFile(join(app, "skills-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
    git(
      app,
      "add",
      "skills-lock.json",
      ".agents/skills/pdf",
      ".agents/skills/houserules",
      ".claude/skills/houserules",
      ".agents/skills/zip",
    );
    git(app, "commit", "-qm", "skills");
    return app;
  };

  test("committed Skills Dark Matter didn't create are listed as Vendored, lock entries are offered for fulfilment, and nothing is written", async () => {
    const { home, trpc, fixture } = await setup({
      "acme/skills/pdf": { entry: PDF_ENTRY },
      "acme/skills/missing": { entry: { ...PDF_ENTRY, skillPath: "skills/missing/SKILL.md" } },
    });
    const app = await teamRepo(home, fixture);
    await trpc.project.add.mutate({ path: app, agents: ["claude-code", "codex"] });
    const before = await snapshotTree(app);

    const repo = await trpc.project.repoSkills.query({ path: app });
    expect(repo.vendored).toEqual([
      {
        name: "houserules",
        description: "Our rules",
        paths: [".agents/skills/houserules", ".claude/skills/houserules"],
      },
    ]);
    expect(repo.locked).toEqual([
      expect.objectContaining({ name: "missing", key: "acme/skills/missing", present: false, message: null }),
      expect.objectContaining({ name: "pdf", key: "acme/skills/pdf", present: true, message: null }),
      // Not in the Library, but a GitHub Source: fulfilling it Imports it first (#30).
      expect.objectContaining({ name: "zip", key: null, present: true, message: null }),
    ]);
    expect(await snapshotTree(app)).toEqual(before);
  });

  test("fulfilling lock entries makes them Copies: a committed folder is kept as is, a missing one is copied from the Library", async () => {
    const { home, libraryHome, trpc, fixture } = await setup({
      "acme/skills/pdf": { entry: PDF_ENTRY },
      "acme/skills/missing": { entry: { ...PDF_ENTRY, skillPath: "skills/missing/SKILL.md" } },
    });
    const app = await teamRepo(home, fixture);
    await trpc.project.add.mutate({ path: app, agents: ["claude-code", "codex"] });
    const pdfBefore = await snapshotTree(join(app, ".agents/skills/pdf"));

    const result = await trpc.project.fulfilLock.mutate({ path: app, names: ["pdf", "missing"] });

    expect(await snapshotTree(join(app, ".agents/skills/pdf"))).toEqual(pdfBefore);
    expect(await readFile(join(app, ".agents/skills/missing/SKILL.md"), "utf8")).toBe(
      await readFile(join(libraryHome, "skills/acme/skills/missing/SKILL.md"), "utf8"),
    );
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe("../../.agents/skills/pdf");
    expect(result.skills.map((skill) => [skill.key, skill.mode, skill.status])).toEqual([
      ["acme/skills/missing", "copy", "on"],
      ["acme/skills/pdf", "copy", "on"],
    ]);
    const lock = await readJson(join(app, "skills-lock.json"));
    expect(Object.keys(lock.skills)).toEqual(["missing", "pdf", "zip"]);
    expect(lock.skills.zip).toEqual({ source: "someone/else", sourceType: "github", computedHash: "" });
    expect((await trpc.project.repoSkills.query({ path: app })).locked.map((entry) => entry.name)).toEqual(["zip"]);

    // Fulfilling zip Imports it from GitHub (#30), which this test's core can't reach.
    await expect(trpc.project.fulfilLock.mutate({ path: app, names: ["zip"] })).rejects.toMatchObject({
      data: { tag: "SourceUnreachable" },
    });
  });

  test("Vendored Skills are never changed: a Link or Copy with the same name is refused as a Name Conflict", async () => {
    const { home, trpc, fixture } = await setup({ "local/houserules": {} });
    const app = await teamRepo(home, fixture);
    await trpc.project.add.mutate({ path: app, agents: ["claude-code", "codex"] });
    const before = await snapshotTree(app);
    for (const mode of ["copy", "link"] as const)
      await expect(
        trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/houserules", mode }] }),
      ).rejects.toMatchObject({ data: { tag: "NameConflict" } });
    expect(await snapshotTree(app)).toEqual(before);
  });
});

describe("Rename Namespace and Project Skills", () => {
  test("renaming a Namespace re-creates its Links, re-keys projects.json and rewrites its Copies' lock entries", async () => {
    const { libraryHome, trpc, project } = await setup({ "local/pdf": {}, "local/notes": {} });
    const app = await project("code/app", ["claude-code", "codex"]);
    await trpc.project.addSkills.mutate({
      skills: [
        { path: app, key: "local/pdf" },
        { path: app, key: "local/notes", mode: "copy" },
      ],
    });
    const hash = (await readJson(join(app, "skills-lock.json"))).skills.notes.computedHash;

    const plan = await trpc.namespace.plan.query({ from: "local", to: "acme/tools" });
    expect(plan.steps).toContainEqual({
      kind: "createLink",
      path: "~/code/app/.agents/skills/pdf",
      target: join(libraryHome, "skills/acme/tools/pdf"),
    });
    await trpc.namespace.rename.mutate({ from: "local", to: "acme/tools", planId: plan.planId });

    for (const folder of [".agents/skills", ".claude/skills"])
      expect(await linkAt(join(app, folder, "pdf"))).toBe(join(libraryHome, "skills/acme/tools/pdf"));
    expect((await readJson(join(libraryHome, "projects.json"))).projects[app].skills).toEqual({
      "acme/tools/notes": { mode: "copy", on: true },
      "acme/tools/pdf": { mode: "link", on: true },
    });
    expect((await readJson(join(app, "skills-lock.json"))).skills.notes).toEqual({
      source: "acme/tools",
      sourceType: "github",
      computedHash: hash,
    });
    expect((await trpc.project.skills.query({ path: app })).map((skill) => [skill.key, skill.status])).toEqual([
      ["acme/tools/notes", "on"],
      ["acme/tools/pdf", "on"],
    ]);
  });
});
