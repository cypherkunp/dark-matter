import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { agentHome, snapshotTree } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

const setup = async () => {
  const { home, libraryHome } = await tempHome();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  return { home, libraryHome, core, fixture: { home, ...agentHome(home) }, trpc: connect(core).trpc };
};

describe("Scan", () => {
  test("lists a Global Skill in the Inbox, grouped by the Agent folder it sits in", async () => {
    const { fixture, trpc } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf", description: "Work with PDFs" });

    await trpc.scan.run.mutate();

    const inbox = await trpc.inbox.list.query();
    expect(inbox.count).toBe(1);
    expect(inbox.globalSkills).toEqual([
      {
        folder: "~/.claude/skills",
        agents: ["claude-code", "cursor", "opencode"],
        findings: [
          expect.objectContaining({
            name: "pdf",
            description: "Work with PDFs",
            realPath: "~/.claude/skills/pdf",
            agents: ["claude-code", "cursor", "opencode"],
          }),
        ],
      },
    ]);
  });

  test("counts a Skill reached through several symlinks once, by its resolved real path", async () => {
    const { fixture, trpc } = await setup();
    await fixture.skill(".agents/skills/pdf", { name: "pdf", description: "Work with PDFs" });
    await fixture.link(".claude/skills/pdf", ".agents/skills/pdf");
    await fixture.link(".cursor/skills/pdf-again", ".claude/skills/pdf");

    await trpc.scan.run.mutate();

    const inbox = await trpc.inbox.list.query();
    expect(inbox.count).toBe(1);
    expect(inbox.globalSkills).toEqual([
      {
        folder: "~/.agents/skills",
        agents: ["cursor", "opencode", "codex", "agents"],
        findings: [
          expect.objectContaining({
            id: "global-skill:~/.agents/skills/pdf",
            realPath: "~/.agents/skills/pdf",
            agents: ["claude-code", "cursor", "opencode", "codex", "agents"],
            localSource: false,
            locations: [
              { folder: "~/.claude/skills", path: "~/.claude/skills/pdf", symlink: true },
              { folder: "~/.cursor/skills", path: "~/.cursor/skills/pdf-again", symlink: true },
              { folder: "~/.agents/skills", path: "~/.agents/skills/pdf", symlink: false },
            ],
          }),
        ],
      },
    ]);
  });

  test("ignores Claude Code's .trash/ and synced/, hidden entries and folders without a SKILL.md", async () => {
    const { fixture, trpc } = await setup();
    await fixture.skill(".claude/skills/kept", { name: "kept" });
    await fixture.skill(".claude/skills/.trash/discarded", { name: "discarded" });
    await fixture.skill(".claude/skills/.trash", { name: "trash-itself" });
    await fixture.skill(".claude/skills/synced", { name: "from-claude-ai" });
    await fixture.skill(".codex/skills/.system/skill-creator", { name: "skill-creator" });
    await fixture.skill(".cursor/skills-cursor/built-in", { name: "built-in" });
    await mkdir(join(fixture.home, ".claude/skills/not-a-skill"), { recursive: true });
    await symlink(join(fixture.home, "nowhere"), join(fixture.home, ".claude/skills/broken"));

    await trpc.scan.run.mutate();

    const inbox = await trpc.inbox.list.query();
    expect(inbox.globalSkills.flatMap((group) => group.findings.map((finding) => finding.name))).toEqual(["kept"]);
  });

  test("names a Skill by its folder when the frontmatter has no name", async () => {
    const { fixture, trpc } = await setup();
    await fixture.skill(".agents/skills/untitled", {});

    await trpc.scan.run.mutate();

    expect((await trpc.inbox.list.query()).globalSkills[0]?.findings[0]).toMatchObject({
      name: "untitled",
      description: "",
    });
  });

  test("marks a symlink to a folder outside every Agent folder as a Local Source", async () => {
    const { fixture, trpc } = await setup();
    await fixture.skill("code/my-skills/mine", { name: "mine" });
    await fixture.link(".claude/skills/mine", "code/my-skills/mine");

    await trpc.scan.run.mutate();

    expect((await trpc.inbox.list.query()).globalSkills).toEqual([
      expect.objectContaining({
        folder: "~/.claude/skills",
        findings: [expect.objectContaining({ realPath: "~/code/my-skills/mine", localSource: true })],
      }),
    ]);
  });

  test("takes a Skill's Source from the skills CLI's global lock", async () => {
    const { fixture, trpc } = await setup();
    await fixture.skill(".agents/skills/find-skills", { name: "find-skills" });
    await fixture.skill(".agents/skills/hand-made", { name: "hand-made" });
    await fixture.globalLock({ "find-skills": { source: "vercel-labs/skills" } });

    await trpc.scan.run.mutate();

    const findings = (await trpc.inbox.list.query()).globalSkills.flatMap((group) => group.findings);
    expect(findings.map(({ name, source }) => ({ name, source }))).toEqual([
      { name: "find-skills", source: "vercel-labs/skills" },
      { name: "hand-made", source: null },
    ]);
  });

  test("writes nothing outside state/ (and the Activity Log)", async () => {
    const { fixture, trpc, home } = await setup();
    await fixture.skill(".agents/skills/pdf", { name: "pdf" });
    await fixture.link(".claude/skills/pdf", ".agents/skills/pdf");
    await fixture.skill("code/my-skills/mine", { name: "mine" });
    await fixture.link(".cursor/skills/mine", "code/my-skills/mine");
    await fixture.skill(".claude/skills/.trash/old", { name: "old" });
    await fixture.globalLock({ pdf: { source: "acme/skills" } });
    const except = [".dark-matter/state", ".dark-matter/activity"];
    const before = await snapshotTree(home, except);

    await trpc.scan.run.mutate();

    expect(await snapshotTree(home, except)).toEqual(before);
  });

  test("records the Scan in the Activity Log", async () => {
    const { trpc } = await setup();

    await trpc.scan.run.mutate();

    expect((await trpc.activity.list.query()).entries).toEqual([
      expect.objectContaining({ client: "app", action: "scan.run", result: "ok", filesWritten: [] }),
    ]);
  });

  test("reports whether a Scan is running and when the last one finished", async () => {
    const { trpc } = await setup();
    expect(await trpc.scan.status.query()).toEqual({ running: false, lastScanAt: null });

    const [first, second] = await Promise.all([trpc.scan.run.mutate(), trpc.scan.run.mutate()]);

    expect(second.scannedAt).toBe(first.scannedAt);
    expect(await trpc.scan.status.query()).toEqual({ running: false, lastScanAt: first.scannedAt });
  });

  test("pushes invalidations for the Inbox and Agents when a Scan finishes", async () => {
    const { trpc } = await setup();
    const domains: string[] = [];
    let started = false;
    trpc.events.subscribe(undefined, {
      onStarted: () => (started = true),
      onData: (event) => domains.push(...event.domains),
    });
    await expect.poll(() => started).toBe(true);

    await trpc.scan.run.mutate();

    await expect.poll(() => domains).toEqual(expect.arrayContaining(["scan", "inbox", "agents"]));
  });
});

describe("Ignoring an Inbox finding", () => {
  test("leaves it out of the Inbox and persists it in settings.json", async () => {
    const { fixture, trpc, libraryHome } = await setup();
    await fixture.skill(".agents/skills/pdf", { name: "pdf" });
    await fixture.skill(".agents/skills/docx", { name: "docx" });
    await trpc.scan.run.mutate();

    await trpc.inbox.ignore.mutate({ id: "global-skill:~/.agents/skills/pdf" });
    await trpc.scan.run.mutate();

    const inbox = await trpc.inbox.list.query();
    expect(inbox.count).toBe(1);
    expect(inbox.ignoredCount).toBe(1);
    expect(inbox.globalSkills.flatMap((group) => group.findings.map((finding) => finding.name))).toEqual(["docx"]);
    expect(JSON.parse(await readFile(join(libraryHome, "settings.json"), "utf8"))).toMatchObject({
      ignoredFindings: ["global-skill:~/.agents/skills/pdf"],
    });
    expect((await trpc.activity.list.query()).entries[1]).toMatchObject({
      action: "inbox.ignore",
      subjects: [{ kind: "finding", id: "global-skill:~/.agents/skills/pdf" }],
      filesWritten: ["~/.dark-matter/settings.json"],
    });
  });
});

describe("the Agents screen", () => {
  test("shows each Agent's global skill folder; detection and counts arrive with the first Scan", async () => {
    const { fixture, trpc } = await setup();
    await fixture.skill(".claude/skills/pdf", { name: "pdf" });
    await fixture.skill(".agents/skills/docx", { name: "docx" });
    await fixture.link(".agents/skills/pdf", ".claude/skills/pdf");
    await mkdir(join(fixture.home, ".config/opencode"), { recursive: true });

    expect(
      (await trpc.agents.list.query()).map(({ id, detected, globalSkillCount }) => ({
        id,
        detected,
        globalSkillCount,
      })),
    ).toEqual([
      { id: "claude-code", detected: null, globalSkillCount: null },
      { id: "cursor", detected: null, globalSkillCount: null },
      { id: "opencode", detected: null, globalSkillCount: null },
      { id: "codex", detected: null, globalSkillCount: null },
      { id: "agents", detected: null, globalSkillCount: null },
    ]);

    await trpc.scan.run.mutate();

    expect(await trpc.agents.list.query()).toEqual([
      {
        id: "claude-code",
        name: "Claude Code",
        detected: true,
        globalSkillFolder: "~/.claude/skills",
        globalSkillCount: 1,
        managedSkillCount: 0,
      },
      {
        id: "cursor",
        name: "Cursor",
        detected: false,
        globalSkillFolder: "~/.cursor/skills",
        globalSkillCount: 2,
        managedSkillCount: 0,
      },
      {
        id: "opencode",
        name: "OpenCode",
        detected: true,
        globalSkillFolder: "~/.config/opencode/skills",
        globalSkillCount: 2,
        managedSkillCount: 0,
      },
      {
        id: "codex",
        name: "Codex",
        detected: false,
        globalSkillFolder: "~/.agents/skills",
        globalSkillCount: 2,
        managedSkillCount: 0,
      },
      {
        id: "agents",
        name: ".agents",
        detected: true,
        globalSkillFolder: "~/.agents/skills",
        globalSkillCount: 2,
        managedSkillCount: 0,
      },
    ]);
  });
});

describe("the Scan cache", () => {
  test("serves the last Scan after a restart", async () => {
    const { home, libraryHome } = await tempHome();
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    await agentHome(home).skill(".agents/skills/pdf", { name: "pdf" });
    const first = await bootCore(env);
    await connect(first).trpc.scan.run.mutate();
    const before = await connect(first).trpc.inbox.list.query();
    await first.stop();

    const second = await bootCore(env);

    expect(await connect(second).trpc.inbox.list.query()).toEqual(before);
  });

  test("a deleted or corrupt cache is rebuilt from files plus a full Scan", async () => {
    const { home, libraryHome } = await tempHome();
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    await agentHome(home).skill(".agents/skills/pdf", { name: "pdf" });
    const first = await bootCore(env);
    await connect(first).trpc.scan.run.mutate();
    const before = await connect(first).trpc.inbox.list.query();
    await first.stop();
    await rm(join(libraryHome, "state"), { recursive: true });
    await mkdir(join(libraryHome, "state"));
    await writeFile(join(libraryHome, "state", "dark-matter.db"), "this is not a database");

    const second = await bootCore(env);
    const { trpc } = connect(second);

    await expect.poll(() => trpc.inbox.list.query()).toEqual(before);
    expect((await trpc.scan.status.query()).lastScanAt).not.toBeNull();
  });

  test("a cache from another version is dropped and rebuilt", async () => {
    const { home, libraryHome } = await tempHome();
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    await agentHome(home).skill(".agents/skills/pdf", { name: "pdf" });
    const first = await bootCore(env);
    await connect(first).trpc.scan.run.mutate();
    const before = await connect(first).trpc.inbox.list.query();
    await first.stop();
    const db = new DatabaseSync(join(libraryHome, "state", "dark-matter.db"));
    db.exec("PRAGMA user_version = 999");
    db.close();

    const second = await bootCore(env);

    await expect.poll(() => connect(second).trpc.inbox.list.query()).toEqual(before);
  });

  test("before the first Scan, nothing is read on start", async () => {
    const { home, libraryHome } = await tempHome();
    await agentHome(home).skill(".agents/skills/pdf", { name: "pdf" });

    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
    const { trpc } = connect(core);

    expect(await trpc.scan.status.query()).toEqual({ running: false, lastScanAt: null });
    expect((await trpc.inbox.list.query()).count).toBe(0);
  });
});
