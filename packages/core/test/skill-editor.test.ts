import { chmod, lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentHome, gitRepo } from "./agent-home";
import { allowAdoptEverywhere, bootCore, connect, fakeClock, localTime, tempHome } from "./harness";

const setup = async (clock = fakeClock(localTime(20, 12))) => {
  const { home, libraryHome } = await tempHome();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }, { clock });
  const { trpc } = connect(core);
  await allowAdoptEverywhere(trpc);
  const fixture = agentHome(home);
  const adopt = async (...realPaths: string[]) => {
    await trpc.scan.run.mutate();
    const plan = await trpc.adopt.plan.query({ findings: realPaths.map((path) => `global-skill:${path}`) });
    await trpc.adopt.execute.mutate({ findings: plan.findings, planId: plan.planId });
  };
  /** A Skill Adopted from `vercel-labs/skills`, so it has a Source and a lock hash. */
  const sourcedSkill = async () => {
    await fixture.skill(".agents/skills/find-skills", { name: "find-skills", description: "Find Skills" }, "# Find\n");
    await fixture.file(".agents/skills/find-skills/scripts/run.sh", "echo hi\n");
    await fixture.globalLock({ "find-skills": { source: "vercel-labs/skills" } });
    await adopt("~/.agents/skills/find-skills");
    return {
      key: "vercel-labs/skills/find-skills",
      folder: join(libraryHome, "skills/vercel-labs/skills/find-skills"),
    };
  };
  /** A git repo confirmed as a Project for Claude Code and Codex. */
  const project = async (dir: string) => {
    const path = await gitRepo(home, dir);
    await trpc.project.add.mutate({ path, agents: ["claude-code", "codex"] });
    return path;
  };
  return { home, libraryHome, trpc, fixture, adopt, sourcedSkill, clock, project };
};

describe("Saving a Skill file", () => {
  test("writes exactly the text given, keeps the file's mode, and logs Activity", async () => {
    const { trpc, sourcedSkill } = await setup();
    const { key, folder } = await sourcedSkill();
    await chmod(join(folder, "scripts/run.sh"), 0o755);

    const text = "#!/bin/sh\r\necho  changed   \n\n";
    const saved = await trpc.skill.saveFile.mutate({ key, path: "scripts/run.sh", content: text });

    expect(saved).toEqual({ warnings: [], modified: true });
    expect(await readFile(join(folder, "scripts/run.sh"), "utf8")).toBe(text);
    expect((await stat(join(folder, "scripts/run.sh"))).mode & 0o777).toBe(0o755);
    const { entries } = await trpc.activity.list.query({});
    expect(entries[0]).toMatchObject({
      action: "skill.saveFile",
      result: "ok",
      subjects: [{ kind: "skill", id: key }],
      filesWritten: ["~/.dark-matter/skills/vercel-labs/skills/find-skills/scripts/run.sh"],
    });
  });

  test("never rewrites SKILL.md: invalid frontmatter is saved as is and comes back as warnings", async () => {
    const { trpc, sourcedSkill } = await setup();
    const { key, folder } = await sourcedSkill();

    const text = "---\nname: Find Skills\n---\n# Find\n";
    const saved = await trpc.skill.saveFile.mutate({ key, path: "SKILL.md", content: text });

    expect(saved.warnings).toEqual([
      { field: "name", message: expect.stringContaining("lowercase") },
      { field: "name", message: "name doesn't match the folder name find-skills" },
      { field: "description", message: "description is missing" },
    ]);
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(text);
  });

  test("Modified follows the Library Lock's computedHash: on after an edit, off once the content matches again", async () => {
    const { trpc, sourcedSkill } = await setup();
    const { key, folder } = await sourcedSkill();
    const original = await readFile(join(folder, "SKILL.md"), "utf8");
    expect((await trpc.skill.get.query({ key })).modified).toBe(false);

    await trpc.skill.saveFile.mutate({ key, path: "SKILL.md", content: `${original}More.\n` });
    expect((await trpc.skill.get.query({ key })).modified).toBe(true);
    expect((await trpc.library.list.query()).skills).toEqual([expect.objectContaining({ key, modified: true })]);

    // CRLF hashes the same as LF (skills-lock v2), so this is back to unmodified.
    await trpc.skill.saveFile.mutate({ key, path: "SKILL.md", content: original.replaceAll("\n", "\r\n") });
    expect((await trpc.skill.get.query({ key })).modified).toBe(false);
  });

  test("a local Skill has no upstream, so it's never Modified", async () => {
    const { trpc, fixture, adopt } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf", description: "PDFs" });
    await adopt("~/.claude/skills/pdf");

    const saved = await trpc.skill.saveFile.mutate({ key: "local/pdf", path: "SKILL.md", content: "changed\n" });
    expect(saved.modified).toBe(false);
  });

  test("an edit to a Linked Skill shows in every Project at once", async () => {
    const { trpc, sourcedSkill, project } = await setup();
    const { key } = await sourcedSkill();
    const projects = [await project("code/app"), await project("code/api")];
    await trpc.project.addSkills.mutate({ skills: projects.map((path) => ({ path, key })) });

    await trpc.skill.saveFile.mutate({ key, path: "scripts/run.sh", content: "echo linked\n" });

    for (const path of projects) {
      for (const folder of [".agents/skills", ".claude/skills"]) {
        expect(await readFile(join(path, folder, "find-skills/scripts/run.sh"), "utf8")).toBe("echo linked\n");
      }
    }
  });

  test("a Local Source is edited where it's authored", async () => {
    const { home, trpc, fixture, adopt } = await setup();
    const authored = await fixture.skill("src/my-skills/tidy", { name: "tidy", description: "Tidy up" });
    await fixture.link(".claude/skills/tidy", authored);
    await adopt(authored.replace(home, "~"));
    const [skill] = (await trpc.library.list.query()).skills;
    if (!skill) throw new Error("not adopted");

    await trpc.skill.saveFile.mutate({ key: skill.key, path: "SKILL.md", content: "authored edit\n" });

    expect(await readFile(join(authored, "SKILL.md"), "utf8")).toBe("authored edit\n");
  });
});

describe("Skill files", () => {
  test("lists a Library Skill's files and reads one", async () => {
    const { trpc, sourcedSkill } = await setup();
    const { key } = await sourcedSkill();

    const { files } = await trpc.skill.files.query({ key });
    expect(files).toEqual([
      { path: "SKILL.md", size: expect.any(Number), binary: false },
      { path: "scripts/run.sh", size: 8, binary: false },
    ]);

    const file = await trpc.skill.readFile.query({ key, path: "scripts/run.sh" });
    expect(file).toEqual({ path: "scripts/run.sh", content: "echo hi\n", binary: false });
  });

  test("a path outside the Skill folder or a missing file is SkillFileNotFound", async () => {
    const { trpc, sourcedSkill } = await setup();
    const { key } = await sourcedSkill();
    for (const path of ["../../../../settings.json", "/etc/hosts", "nope.md"]) {
      await expect(trpc.skill.readFile.query({ key, path })).rejects.toMatchObject({
        data: { tag: "SkillFileNotFound" },
      });
    }
  });
});

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe("Deleting a Library Skill", () => {
  test("moves it into trash/ with its Library Lock entry, and it leaves the Library", async () => {
    const { libraryHome, trpc, sourcedSkill } = await setup();
    const { key, folder } = await sourcedSkill();

    expect(await trpc.skill.deletePlan.query({ key })).toEqual({ key, retentionDays: 30, projects: [] });
    await trpc.skill.delete.mutate({ key });

    expect(await exists(folder)).toBe(false);
    expect((await trpc.library.list.query()).skills).toEqual([]);
    await expect(trpc.skill.get.query({ key })).rejects.toMatchObject({ data: { tag: "SkillNotFound" } });
    const [trashed] = await readdir(join(libraryHome, "trash"));
    if (!trashed) throw new Error("nothing in trash/");
    expect(await readFile(join(libraryHome, "trash", trashed, "find-skills/scripts/run.sh"), "utf8")).toBe("echo hi\n");
    expect(JSON.parse(await readFile(join(libraryHome, "trash", trashed, "trashed.json"), "utf8"))).toEqual({
      key,
      deletedAt: localTime(20, 12).toISOString(),
      entry: expect.objectContaining({ source: "vercel-labs/skills" }),
    });
    const { entries } = await trpc.activity.list.query({});
    expect(entries[0]).toMatchObject({ action: "skill.delete", result: "ok", subjects: [{ kind: "skill", id: key }] });
  });

  test("warns about the Projects whose Links would break", async () => {
    const { trpc, sourcedSkill, project } = await setup();
    const { key } = await sourcedSkill();
    const app = await project("code/app");
    const api = await project("code/api");
    await trpc.project.addSkills.mutate({
      skills: [
        { path: app, key },
        { path: api, key },
      ],
    });
    await trpc.project.setSkillOn.mutate({ path: api, key, on: false });

    expect((await trpc.skill.deletePlan.query({ key })).projects).toEqual([
      { path: api, projectName: "api", mode: "link", on: false },
      { path: app, projectName: "app", mode: "link", on: true },
    ]);

    // Deleting anyway leaves the Projects readable.
    await trpc.skill.delete.mutate({ key });
    await expect(trpc.project.skills.query({ path: app })).resolves.toBeDefined();
    await expect(trpc.library.list.query()).resolves.toEqual({ skills: [] });
  });

  test("a Local Source loses only its Library symlink; the folder it's authored in stays", async () => {
    const { home, trpc, fixture, adopt } = await setup();
    const authored = await fixture.skill("src/my-skills/tidy", { name: "tidy", description: "Tidy up" });
    await fixture.link(".claude/skills/tidy", authored);
    await adopt(authored.replace(home, "~"));
    const [skill] = (await trpc.library.list.query()).skills;
    if (!skill) throw new Error("not adopted");

    await trpc.skill.delete.mutate({ key: skill.key });

    expect(await readFile(join(authored, "SKILL.md"), "utf8")).toContain("tidy");
  });

  test("the retention comes from Settings", async () => {
    const { trpc, sourcedSkill } = await setup();
    const { key } = await sourcedSkill();
    await trpc.settings.updatePreferences.mutate({ trashRetentionDays: 7 });
    expect((await trpc.skill.deletePlan.query({ key })).retentionDays).toBe(7);
  });

  test("the Scheduled Scan purges trash older than the retention, and only that", async () => {
    const clock = fakeClock(localTime(1, 8));
    const { libraryHome, trpc, fixture, adopt, sourcedSkill } = await setup(clock);
    const { key } = await sourcedSkill();
    await trpc.skill.delete.mutate({ key });
    clock.set(localTime(10, 8));
    await fixture.skill(".claude/skills/pdf", { name: "pdf", description: "PDFs" });
    await adopt("~/.claude/skills/pdf");
    await trpc.skill.delete.mutate({ key: "local/pdf" });
    expect(await readdir(join(libraryHome, "trash"))).toHaveLength(2);

    // 1 December (Nov 31) at 09:00: the first is 30 days old, the second 21.
    clock.set(localTime(31, 9));

    await expect.poll(async () => (await readdir(join(libraryHome, "trash"))).length, { timeout: 5000 }).toBe(1);
    const [left] = await readdir(join(libraryHome, "trash"));
    expect(left).toContain("local");
    await expect
      .poll(async () => (await trpc.activity.list.query({})).entries.find((entry) => entry.action === "trash.purge"))
      .toMatchObject({ client: "scheduled-scan", result: "ok", subjects: [{ kind: "skill", id: key }] });
    // The first poll may take its full 5 s, Vitest's default test timeout.
  }, 15_000);
});

describe("Restore from trash (story 44)", () => {
  test("a deleted Skill is listed in the trash and Restore puts its folder and Library Lock entry back", async () => {
    const { libraryHome, trpc, sourcedSkill } = await setup();
    const { key, folder } = await sourcedSkill();
    const entry = (await trpc.skill.get.query({ key })).entry;
    await trpc.skill.delete.mutate({ key });

    const [trashed, ...rest] = await trpc.trash.list.query();
    expect(rest).toEqual([]);
    expect(trashed).toMatchObject({
      key,
      name: "find-skills",
      deletedAt: localTime(20, 12).toISOString(),
      purgeAt: localTime(50, 12).toISOString(),
    });

    await trpc.trash.restore.mutate({ id: trashed?.id ?? "" });

    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toContain("# Find");
    expect((await trpc.skill.get.query({ key })).entry).toEqual(entry);
    expect(await trpc.trash.list.query()).toEqual([]);
    expect(await readdir(join(libraryHome, "trash"))).toEqual([]);
    const [restored] = (await trpc.activity.list.query({ actions: ["trash.restore"] })).entries;
    expect(restored).toMatchObject({ result: "ok", subjects: [{ kind: "skill", id: key }] });
  });

  test("Restore is refused while another Skill holds the key, and changes nothing", async () => {
    const { trpc, fixture, adopt } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf", description: "PDFs" });
    await adopt("~/.claude/skills/pdf");
    await trpc.skill.delete.mutate({ key: "local/pdf" });
    await fixture.skill(".claude/skills/pdf", { name: "pdf", description: "PDFs, again" });
    await adopt("~/.claude/skills/pdf");
    const [trashed] = await trpc.trash.list.query();

    await expect(trpc.trash.restore.mutate({ id: trashed?.id ?? "" })).rejects.toMatchObject({
      data: { tag: "PathTaken" },
    });
    expect(await trpc.trash.list.query()).toHaveLength(1);
    expect((await trpc.skill.get.query({ key: "local/pdf" })).frontmatter).toContain("PDFs, again");
  });
});
