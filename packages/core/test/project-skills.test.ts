import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { agentHome, gitRepo } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

/** Library Skills written before the core starts: folders under `skills/` plus their Library Lock entries. */
const seedLibrary = async (libraryHome: string, skills: Record<string, { name?: string; description?: string }>) => {
  const fixture = agentHome(libraryHome);
  const entries: Record<string, unknown> = {};
  for (const [key, frontmatter] of Object.entries(skills)) {
    await fixture.skill(join(libraryHome, "skills", key), { description: `About ${key}`, ...frontmatter });
    entries[key] = { source: key, sourceType: "local", computedHash: "0".repeat(64) };
  }
  await mkdir(libraryHome, { recursive: true });
  await writeFile(join(libraryHome, "library-lock.json"), JSON.stringify({ version: 1, skills: entries }));
};

const setup = async (skills: Record<string, { name?: string; description?: string }> = { "local/pdf": {} }) => {
  const { home, libraryHome } = await tempHome();
  await seedLibrary(libraryHome, skills);
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
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const excludeOf = (project: string) => readFile(join(project, ".git/info/exclude"), "utf8");

describe("Project Skills as Links", () => {
  test("adding one links its Library folder into .agents/skills and .claude/skills, excluded from git, and records it in projects.json", async () => {
    const { libraryHome, trpc, project } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    await writeFile(join(app, "skills-lock.json"), '{"version":1,"skills":{}}\n');

    const added = await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });

    const library = join(libraryHome, "skills/local/pdf");
    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBe(library);
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe(library);
    // A directory symlink: SKILL.md inside is the Library's real file (Codex rejects a symlinked SKILL.md).
    expect((await lstat(join(app, ".agents/skills/pdf/SKILL.md"))).isFile()).toBe(true);
    expect(await excludeOf(app)).toContain("/.agents/skills/pdf\n/.claude/skills/pdf\n");
    expect(await readFile(join(app, "skills-lock.json"), "utf8")).toBe('{"version":1,"skills":{}}\n');
    expect((await readJson(join(libraryHome, "projects.json"))).projects[app]).toEqual({
      agents: ["claude-code", "codex"],
      skills: { "local/pdf": { mode: "link", on: true } },
    });
    const view = {
      key: "local/pdf",
      namespace: "local",
      name: "pdf",
      mode: "link",
      on: true,
      status: "on",
      conflictsWith: [],
      paths: [".agents/skills/pdf", ".claude/skills/pdf"],
    };
    expect(added).toEqual([{ path: app, skills: [view] }]);
    expect(await trpc.project.skills.query({ path: app })).toEqual([view]);
  });

  test("Off deletes the Link but keeps its mode in projects.json, On re-creates it, Remove forgets it", async () => {
    const { libraryHome, trpc, project } = await setup();
    const app = await project("code/app", ["claude-code", "cursor"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });
    const recorded = async () => (await readJson(join(libraryHome, "projects.json"))).projects[app].skills;

    const off = await trpc.project.setSkillOn.mutate({ path: app, key: "local/pdf", on: false });

    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBeNull();
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBeNull();
    expect(await excludeOf(app)).not.toContain("pdf");
    expect(await recorded()).toEqual({ "local/pdf": { mode: "link", on: false } });
    expect(off.skills).toEqual([expect.objectContaining({ key: "local/pdf", on: false, status: "off" })]);

    await trpc.project.setSkillOn.mutate({ path: app, key: "local/pdf", on: true });

    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
    expect(await recorded()).toEqual({ "local/pdf": { mode: "link", on: true } });

    const removed = await trpc.project.removeSkill.mutate({ path: app, key: "local/pdf" });

    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBeNull();
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBeNull();
    expect(await excludeOf(app)).not.toContain("Dark Matter");
    expect(await recorded()).toEqual({});
    expect(removed.skills).toEqual([]);
    expect(await trpc.project.skills.query({ path: app })).toEqual([]);
  });

  test("On/Off is the same for every Agent: only skill folders change, never an Agent's settings", async () => {
    const { home, trpc, project, fixture } = await setup();
    const app = await project("code/app", ["cursor", "opencode", "codex"]);
    const settings = await fixture.file(join(app, ".claude/settings.json"), '{ "skillOverrides": {} }\n');
    await fixture.file(".codex/config.toml", "");

    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });
    await trpc.project.setSkillOn.mutate({ path: app, key: "local/pdf", on: false });

    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBeNull();
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBeNull();
    expect(await readFile(settings, "utf8")).toBe('{ "skillOverrides": {} }\n');
    expect(await readFile(join(home, ".codex/config.toml"), "utf8")).toBe("");

    await trpc.project.setSkillOn.mutate({ path: app, key: "local/pdf", on: true });

    expect(await linkAt(join(app, ".agents/skills/pdf"))).not.toBeNull();
    // Without Claude Code, .claude/skills isn't written.
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBeNull();
  });

  test("changing a Project's Agents re-delivers its Project Skills to the right folders", async () => {
    const { libraryHome, trpc, project } = await setup({ "local/pdf": {}, "local/lint": {} });
    const app = await project("code/app", ["codex"]);
    await trpc.project.addSkills.mutate({
      skills: [
        { path: app, key: "local/pdf" },
        { path: app, key: "local/lint" },
      ],
    });
    await trpc.project.setSkillOn.mutate({ path: app, key: "local/lint", on: false });

    await trpc.project.setAgents.mutate({ path: app, agents: ["claude-code"] });

    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBeNull();
    expect(await linkAt(join(app, ".claude/skills/lint"))).toBeNull();
    expect(await excludeOf(app)).toContain("/.claude/skills/pdf\n");
    expect(await excludeOf(app)).not.toContain("/.agents/skills/pdf");
    expect((await readJson(join(libraryHome, "projects.json"))).projects[app]).toEqual({
      agents: ["claude-code"],
      skills: { "local/lint": { mode: "link", on: false }, "local/pdf": { mode: "link", on: true } },
    });

    await trpc.project.setAgents.mutate({ path: app, agents: ["claude-code", "opencode"] });

    expect(await linkAt(join(app, ".claude/skills/pdf"))).not.toBeNull();
    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
  });

  test("two same-name Skills in one Project are a Name Conflict: the switch is refused until Resolve picks one", async () => {
    const { libraryHome, trpc, project } = await setup({
      "acme/tools/pdf": { name: "pdf" },
      "local/pdf-1a2b3c4": { name: "pdf" },
    });
    const app = await project("code/app", ["codex"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "acme/tools/pdf" }] });

    const [added] = await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf-1a2b3c4" }] });

    expect(added?.skills).toEqual([
      expect.objectContaining({ key: "acme/tools/pdf", status: "nameConflict", conflictsWith: ["local/pdf-1a2b3c4"] }),
      expect.objectContaining({ key: "local/pdf-1a2b3c4", status: "nameConflict", conflictsWith: ["acme/tools/pdf"] }),
    ]);
    // What was delivered stays delivered until you Resolve.
    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBe(join(libraryHome, "skills/acme/tools/pdf"));
    await expect(trpc.project.setSkillOn.mutate({ path: app, key: "acme/tools/pdf", on: false })).rejects.toMatchObject(
      { data: { tag: "NameConflict" } },
    );

    const resolved = await trpc.project.resolveConflict.mutate({ path: app, key: "local/pdf-1a2b3c4" });

    expect(resolved.skills).toEqual([
      expect.objectContaining({ key: "local/pdf-1a2b3c4", name: "pdf", status: "on", conflictsWith: [] }),
    ]);
    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf-1a2b3c4"));
    expect(Object.keys((await readJson(join(libraryHome, "projects.json"))).projects[app].skills)).toEqual([
      "local/pdf-1a2b3c4",
    ]);
  });

  test("a folder Dark Matter didn't put there is never overwritten: adding is refused as a Name Conflict", async () => {
    const { libraryHome, trpc, project, fixture } = await setup({ "local/pdf": {}, "local/lint": {} });
    const api = await project("code/api", ["claude-code"]);
    const app = await project("code/app", ["claude-code"]);
    await fixture.skill(join(app, ".claude/skills/pdf"), { name: "pdf", description: "Vendored" });

    await expect(
      trpc.project.addSkills.mutate({
        skills: [
          { path: api, key: "local/pdf" },
          { path: app, key: "local/lint" },
          { path: app, key: "local/pdf" },
        ],
      }),
    ).rejects.toMatchObject({ data: { tag: "NameConflict" } });

    // Nothing is written in any Project when one of them can't take it.
    expect(await linkAt(join(api, ".claude/skills/pdf"))).toBeNull();
    expect((await readJson(join(libraryHome, "projects.json"))).projects[api].skills).toEqual({});

    expect(await readFile(join(app, ".claude/skills/pdf/SKILL.md"), "utf8")).toContain("Vendored");
    expect(await linkAt(join(app, ".claude/skills/lint"))).toBeNull();
    expect((await readJson(join(libraryHome, "projects.json"))).projects[app].skills).toEqual({});
  });

  test("Library rows show how many Projects use each Skill and whether it's in a Name Conflict", async () => {
    const { trpc, project } = await setup({
      "acme/tools/pdf": { name: "pdf" },
      "local/pdf-1a2b3c4": { name: "pdf" },
      "local/lint": {},
    });
    const app = await project("code/app", ["codex"]);
    const api = await project("code/api", ["claude-code"]);
    await trpc.project.addSkills.mutate({
      skills: [
        { path: app, key: "acme/tools/pdf" },
        { path: api, key: "acme/tools/pdf" },
        { path: api, key: "local/pdf-1a2b3c4" },
      ],
    });
    await trpc.project.setSkillOn.mutate({ path: app, key: "acme/tools/pdf", on: false });

    const rows = (await trpc.library.list.query()).skills.map(({ key, projects, nameConflict }) => ({
      key,
      projects,
      nameConflict,
    }));

    expect(rows).toEqual([
      { key: "acme/tools/pdf", projects: 2, nameConflict: true },
      { key: "local/lint", projects: 0, nameConflict: false },
      { key: "local/pdf-1a2b3c4", projects: 1, nameConflict: true },
    ]);
    expect(await trpc.project.forSkill.query({ key: "acme/tools/pdf" })).toEqual([
      expect.objectContaining({ path: api, projectName: "api", mode: "link", status: "nameConflict" }),
      expect.objectContaining({ path: app, projectName: "app", mode: "link", on: false, status: "off" }),
    ]);
  });

  test("every change is in the Activity Log with the files it wrote", async () => {
    const { trpc, project } = await setup();
    const app = await project("code/app", ["codex"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });
    await trpc.project.setSkillOn.mutate({ path: app, key: "local/pdf", on: false });
    await trpc.project.setSkillOn.mutate({ path: app, key: "local/pdf", on: true });
    await trpc.project.removeSkill.mutate({ path: app, key: "local/pdf" });

    const { entries } = await trpc.activity.list.query({});
    const ours = entries.filter((entry) => entry.action !== "project.add").reverse();

    expect(ours.map((entry) => entry.action)).toEqual([
      "project.addSkills",
      "project.skillOff",
      "project.skillOn",
      "project.removeSkill",
    ]);
    expect(ours[0]?.subjects).toEqual([
      { kind: "project", id: app },
      { kind: "skill", id: "local/pdf" },
    ]);
    expect(ours[0]?.filesWritten).toEqual(
      expect.arrayContaining(["~/code/app/.agents/skills/pdf", "~/code/app/.git/info/exclude"]),
    );
  });

  test("a git worktree's Links are excluded in the main repo's info/exclude; a Project without git gets none", async () => {
    const { home, trpc, project, fixture } = await setup();
    const app = await project("code/app", ["codex"]);
    await fixture.file(join(app, "README.md"), "hi\n");
    execFileSync("git", [
      "-C",
      app,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qam",
      "init",
      "--allow-empty",
    ]);
    const tree = join(home, "code/app-feature");
    execFileSync("git", ["-C", app, "worktree", "add", "-q", tree]);
    await trpc.project.add.mutate({ path: tree, agents: ["codex"] });
    const plain = join(home, "notes");
    await mkdir(plain);
    await trpc.project.add.mutate({ path: plain, agents: ["codex"] });

    await trpc.project.addSkills.mutate({
      skills: [
        { path: tree, key: "local/pdf" },
        { path: plain, key: "local/pdf" },
      ],
    });

    expect(await excludeOf(app)).toContain("/.agents/skills/pdf\n");
    expect(await linkAt(join(tree, ".agents/skills/pdf"))).not.toBeNull();
    expect(await linkAt(join(plain, ".agents/skills/pdf"))).not.toBeNull();
    expect(await lstat(join(plain, ".git")).catch(() => null)).toBeNull();
  });
});
