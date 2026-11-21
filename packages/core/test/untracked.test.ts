import { execFileSync } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { agentHome, gitRepo } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

const setup = async () => {
  const { home, libraryHome } = await tempHome();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  const { trpc } = connect(core);
  const fixture = agentHome(home);
  /** A git repo confirmed as a Project with these Agents. */
  const project = async (dir: string, agents: AgentId[]) => {
    const path = await gitRepo(home, dir);
    await trpc.project.add.mutate({ path, agents });
    return path;
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });
  const untracked = async () => {
    await trpc.scan.run.mutate();
    return (await trpc.inbox.list.query()).untrackedSkills;
  };
  return { home, libraryHome, trpc, fixture, project, git, untracked };
};

const linkAt = (path: string) =>
  lstat(path).then(
    async (info) => (info.isSymbolicLink() ? readlink(path) : `not a symlink (${info.isDirectory() ? "dir" : "file"})`),
    () => null,
  );

describe("untracked Project Skills", () => {
  test("the Inbox lists untracked Skills by Project; git-tracked ones stay Vendored and aren't offered", async () => {
    const { trpc, fixture, project, git, untracked } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    await fixture.skill(join(app, ".agents/skills/pdf"), { name: "pdf", description: "Read PDFs" });
    await fixture.skill(join(app, ".claude/skills/team"), { name: "team", description: "Committed" });
    git(app, "add", ".claude/skills/team");
    git(app, "commit", "--quiet", "-m", "vendor team");

    const groups = await untracked();

    expect(groups).toEqual([
      {
        project: app,
        name: "app",
        findings: [
          {
            id: "untracked-skill:~/code/app/.agents/skills/pdf",
            project: app,
            name: "pdf",
            description: "Read PDFs",
            realPath: "~/code/app/.agents/skills/pdf",
            locations: [{ folder: ".agents/skills", path: "~/code/app/.agents/skills/pdf", symlink: false }],
            localSource: false,
          },
        ],
      },
    ]);
    expect((await trpc.inbox.list.query()).count).toBe(1);

    await trpc.inbox.ignore.mutate({ id: "untracked-skill:~/code/app/.agents/skills/pdf" });
    const inbox = await trpc.inbox.list.query();
    expect([inbox.count, inbox.ignoredCount, inbox.untrackedSkills]).toEqual([0, 1, []]);
  });

  test("a Skill reached through a symlink in another folder is one finding; Links to the Library aren't findings", async () => {
    const { trpc, libraryHome, fixture, project, untracked } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    await fixture.skill(join(app, ".agents/skills/pdf"), { name: "pdf" });
    await fixture.link(join(app, ".claude/skills/pdf"), join(app, ".agents/skills/pdf"));
    // An Adopted Skill delivered as a Link is already managed.
    await fixture.skill(join(libraryHome, "skills/local/csv"), { name: "csv" });
    await fixture.file(
      join(libraryHome, "library-lock.json"),
      JSON.stringify({ version: 1, skills: { "local/csv": { source: "x", sourceType: "local", computedHash: "0" } } }),
    );
    await expect.poll(async () => (await trpc.library.list.query()).skills.length).toBe(1);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/csv" }] });

    const [group] = await untracked();

    expect(group?.findings.map((finding) => [finding.name, finding.locations.map((l) => l.path)])).toEqual([
      ["pdf", ["~/code/app/.agents/skills/pdf", "~/code/app/.claude/skills/pdf"]],
    ]);
  });

  test("Adopt & keep Link moves the Skill into the Library and puts a Link back, On: the Agent's path shows the same content", async () => {
    const { home, libraryHome, trpc, fixture, project, untracked } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    await fixture.skill(join(app, ".agents/skills/pdf"), { name: "pdf", description: "Read PDFs" }, "Use pdftotext.\n");
    const before = await readFile(join(app, ".agents/skills/pdf/SKILL.md"), "utf8");
    const [group] = await untracked();
    const id = group?.findings[0]?.id ?? "";

    const plan = await trpc.adopt.plan.query({ findings: [id] });
    expect(plan.skills).toEqual([expect.objectContaining({ key: "local/pdf", outcome: "moved" })]);
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        { kind: "move", from: "~/code/app/.agents/skills/pdf", to: "~/.dark-matter/skills/local/pdf" },
        expect.objectContaining({ kind: "createLink", path: "~/code/app/.agents/skills/pdf" }),
      ]),
    );
    expect(plan.warnings).toEqual([]);
    await trpc.adopt.execute.mutate({ findings: [id], planId: plan.planId });

    const library = join(libraryHome, "skills/local/pdf");
    expect((await lstat(library)).isDirectory()).toBe(true);
    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBe(library);
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe(library);
    expect(await readFile(join(app, ".agents/skills/pdf/SKILL.md"), "utf8")).toBe(before);
    expect(await readFile(join(app, ".git/info/exclude"), "utf8")).toContain("/.agents/skills/pdf\n");
    expect(await trpc.project.skills.query({ path: app })).toEqual([
      expect.objectContaining({ key: "local/pdf", mode: "link", on: true, status: "on" }),
    ]);
    const lock = JSON.parse(await readFile(join(libraryHome, "library-lock.json"), "utf8"));
    expect(lock.skills["local/pdf"]).toMatchObject({ adoptedFrom: "~/code/app/.agents/skills/pdf" });
    expect(await untracked()).toEqual([]);

    const [entry] = (await trpc.activity.list.query()).entries.filter((e) => e.action === "adopt.apply");
    expect(entry).toMatchObject({
      result: "ok",
      subjects: expect.arrayContaining([
        { kind: "skill", id: "local/pdf" },
        { kind: "project", id: app },
      ]),
    });
    expect(entry?.filesWritten).toEqual(
      expect.arrayContaining([
        "~/.dark-matter/skills/local/pdf",
        "~/code/app/.agents/skills/pdf",
        "~/.dark-matter/projects.json",
      ]),
    );
    expect(home).toBeTruthy();
  });

  test("a Skill found in a folder the Project's Agents don't use gets its Agent added, so it stays visible", async () => {
    const { libraryHome, trpc, fixture, project, untracked } = await setup();
    const app = await project("code/app", ["codex"]);
    await fixture.skill(join(app, ".claude/skills/pdf"), { name: "pdf" });
    const id = (await untracked())[0]?.findings[0]?.id ?? "";

    const plan = await trpc.adopt.plan.query({ findings: [id] });
    expect(plan.warnings).toEqual([expect.stringContaining("Claude Code")]);
    await trpc.adopt.execute.mutate({ findings: [id], planId: plan.planId });

    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
    expect((await trpc.project.get.query({ path: app })).agents).toEqual(["claude-code", "codex"]);

    // Undo Adopt puts the Project's Agents back as they were (review #17).
    await trpc.adopt.undo.mutate({ key: "local/pdf" });
    expect((await trpc.project.get.query({ path: app })).agents).toEqual(["codex"]);
    expect(await readFile(join(app, ".claude/skills/pdf/SKILL.md"), "utf8")).toContain("pdf");
  });

  test("an untracked Skill identical to a Library Skill merges into it; a symlink out of the Project becomes a Local Source", async () => {
    const { home, libraryHome, trpc, fixture, project, untracked } = await setup();
    const app = await project("code/app", ["codex"]);
    await fixture.skill(join(app, ".agents/skills/pdf"), { name: "pdf" });
    await fixture.skill("src/my-skills/lint", { name: "lint" });
    await fixture.link(join(app, ".agents/skills/lint"), "src/my-skills/lint");
    const ids = (await untracked())[0]?.findings.map((finding) => finding.id) ?? [];

    const plan = await trpc.adopt.plan.query({ findings: ids });
    expect(plan.skills.map((skill) => [skill.name, skill.outcome])).toEqual([
      ["lint", "localSource"],
      ["pdf", "moved"],
    ]);
    await trpc.adopt.execute.mutate({ findings: ids, planId: plan.planId });

    expect(await linkAt(join(libraryHome, "skills/local/lint"))).toBe(join(home, "src/my-skills/lint"));
    expect(await linkAt(join(app, ".agents/skills/lint"))).toBe(join(libraryHome, "skills/local/lint"));
    expect((await lstat(join(home, "src/my-skills/lint/SKILL.md"))).isFile()).toBe(true);

    // The same bytes in a second Project merge into the Library Skill.
    const web = await project("code/web", ["codex"]);
    await fixture.skill(join(web, ".agents/skills/pdf"), { name: "pdf" });
    const again = (await untracked())[0]?.findings.map((finding) => finding.id) ?? [];
    const merge = await trpc.adopt.plan.query({ findings: again });
    expect(merge.skills).toEqual([expect.objectContaining({ key: "local/pdf", outcome: "merged" })]);
    await trpc.adopt.execute.mutate({ findings: again, planId: merge.planId });
    expect(await linkAt(join(web, ".agents/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
  });

  test("Undo Adopt puts the untracked folder back and the Project forgets the Project Skill", async () => {
    const { libraryHome, trpc, fixture, project, untracked } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    await fixture.skill(join(app, ".agents/skills/pdf"), { name: "pdf" });
    const id = (await untracked())[0]?.findings[0]?.id ?? "";
    const plan = await trpc.adopt.plan.query({ findings: [id] });
    await trpc.adopt.execute.mutate({ findings: [id], planId: plan.planId });

    await trpc.adopt.undo.mutate({ key: "local/pdf" });

    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBe("not a symlink (dir)");
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBeNull();
    expect(await linkAt(join(libraryHome, "skills/local/pdf"))).toBeNull();
    expect(await trpc.project.skills.query({ path: app })).toEqual([]);
    expect((await untracked())[0]?.findings).toHaveLength(1);
  });
});
