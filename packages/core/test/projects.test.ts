import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { agentHistory, agentHome, gitRepo, snapshotTree } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

const setup = async () => {
  const { home, libraryHome } = await tempHome();
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  return {
    home,
    libraryHome,
    core,
    fixture: agentHome(home),
    history: agentHistory(home),
    trpc: connect(core).trpc,
  };
};

describe("Suggested Projects", () => {
  test("come from Claude Code's ~/.claude.json, at the git toplevel of the folder worked in", async () => {
    const { home, history, trpc } = await setup();
    const app = await gitRepo(home, "code/app");
    await mkdir(join(app, "packages/web"), { recursive: true });
    await history.claudeJson([join(app, "packages/web")]);

    await trpc.scan.run.mutate();

    expect((await trpc.project.suggested.query()).suggested).toEqual([
      { path: app, name: "app", git: true, agents: ["claude-code"] },
    ]);
  });

  test("merge every Agent's history: Claude Code sessions, Cursor workspaces, OpenCode's project table, Codex sessions", async () => {
    const { home, history, trpc } = await setup();
    const app = await gitRepo(home, "code/app");
    const api = await gitRepo(home, "code/api");
    const notes = join(home, "notes");
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(notes);
    await history.claudeSession(join(app, "src"));
    await history.cursorWorkspaces([
      pathToFileURL(app).href,
      pathToFileURL(notes).href,
      "vscode-remote://ssh-remote+box/srv/app",
      pathToFileURL(join(home, "all.code-workspace")).href,
    ]);
    await history.opencodeProjects([api, "/"]);
    await history.codexSession(api);
    await history.codexSession(app, "rollout-2026-11-20T11-00-00-0002");

    await trpc.scan.run.mutate();

    expect((await trpc.project.suggested.query()).suggested).toEqual([
      { path: api, name: "api", git: true, agents: ["opencode", "codex"] },
      { path: app, name: "app", git: true, agents: ["claude-code", "cursor", "codex"] },
      { path: notes, name: "notes", git: false, agents: ["cursor"] },
    ]);
  });

  test("leave out $HOME, folders that are gone and the Library, and skip history they can't read", async () => {
    const { home, libraryHome, history, trpc } = await setup();
    await gitRepo(home, ".");
    await mkdir(join(libraryHome, "skills"), { recursive: true });
    const kept = join(home, "kept");
    await mkdir(kept);
    await history.claudeJson([home, join(home, "deleted"), join(libraryHome, "skills"), kept, "relative/path"]);
    await mkdir(join(home, ".claude/projects/garbled"), { recursive: true });
    await writeFile(join(home, ".claude/projects/garbled/x.jsonl"), "not json at all\n");
    await mkdir(join(home, ".codex/sessions/2026"), { recursive: true });
    await writeFile(join(home, ".codex/sessions/2026/rollout-bad.jsonl"), '{"type":"session_meta"');
    await mkdir(join(home, ".local/share/opencode"), { recursive: true });
    await writeFile(join(home, ".local/share/opencode/opencode.db"), "this is not a database");

    await trpc.scan.run.mutate();

    expect((await trpc.project.suggested.query()).suggested).toEqual([
      { path: kept, name: "kept", git: false, agents: ["claude-code"] },
    ]);
  });

  test("reading history writes nothing", async () => {
    const { home, history, trpc } = await setup();
    const app = await gitRepo(home, "code/app");
    await history.claudeJson([app]);
    await history.claudeSession(app);
    await history.cursorWorkspaces([pathToFileURL(app).href]);
    await history.opencodeProjects([app]);
    await history.codexSession(app);
    const except = [".dark-matter/state", ".dark-matter/activity"];
    const before = await snapshotTree(home, except);

    await trpc.scan.run.mutate();

    expect((await trpc.project.suggested.query()).suggested).toHaveLength(1);
    expect(await snapshotTree(home, except)).toEqual(before);
  });

  test("are counted in the Inbox until confirmed or dismissed", async () => {
    const { home, history, trpc } = await setup();
    await history.claudeJson([await gitRepo(home, "code/app"), await gitRepo(home, "code/api")]);

    await trpc.scan.run.mutate();

    expect(await trpc.inbox.list.query()).toMatchObject({ count: 2, suggestedProjects: 2 });
  });
});

describe("Dismissing a Suggested Project", () => {
  test("persists in settings.json and survives a new Scan and a restart", async () => {
    const { home, libraryHome } = await tempHome();
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    const app = await gitRepo(home, "code/app");
    const api = await gitRepo(home, "code/api");
    await agentHistory(home).claudeJson([app, api]);
    const firstCore = await bootCore(env);
    const first = connect(firstCore).trpc;
    await first.scan.run.mutate();

    await first.project.dismiss.mutate({ path: app });

    expect(await first.project.suggested.query()).toEqual({
      suggested: [expect.objectContaining({ path: api })],
      dismissedCount: 1,
    });
    expect(JSON.parse(await readFile(join(libraryHome, "settings.json"), "utf8"))).toMatchObject({
      dismissedSuggestedProjects: [app],
    });
    expect((await first.activity.list.query()).entries[0]).toMatchObject({
      action: "project.dismiss",
      subjects: [{ kind: "project", id: app }],
      filesWritten: ["~/.dark-matter/settings.json"],
    });

    await firstCore.stop();
    const second = connect(await bootCore(env)).trpc;
    await second.scan.run.mutate();
    expect((await second.project.suggested.query()).suggested.map((s) => s.path)).toEqual([api]);
    expect((await second.inbox.list.query()).suggestedProjects).toBe(1);
  });
});

describe("Confirming a Project", () => {
  test("Manage records it in projects.json by absolute path, with the Agents detected in it", async () => {
    const { home, libraryHome, history, trpc } = await setup();
    const app = await gitRepo(home, "code/app");
    await mkdir(join(app, ".cursor"));
    await history.codexSession(app);
    await trpc.scan.run.mutate();

    const project = await trpc.project.add.mutate({ path: app });

    expect(project).toMatchObject({
      path: app,
      name: "app",
      exists: true,
      git: true,
      agents: ["cursor", "codex"],
      folders: [".agents/skills"],
    });
    expect(JSON.parse(await readFile(join(libraryHome, "projects.json"), "utf8"))).toEqual({
      projects: { [app]: { agents: ["cursor", "codex"] } },
    });
    expect((await trpc.project.suggested.query()).suggested).toEqual([]);
    expect(await trpc.project.list.query()).toEqual([
      { path: app, name: "app", exists: true, agents: ["cursor", "codex"] },
    ]);
    expect((await trpc.activity.list.query()).entries[0]).toMatchObject({
      action: "project.add",
      subjects: [{ kind: "project", id: app }],
      filesWritten: ["~/.dark-matter/projects.json"],
    });
  });

  test("Add folder… uses the git toplevel, or the folder itself when there's no git", async () => {
    const { home, trpc } = await setup();
    const app = await gitRepo(home, "code/app");
    await mkdir(join(app, "packages/web"), { recursive: true });
    const scratch = join(home, "scratch/notes");
    await mkdir(scratch, { recursive: true });

    await trpc.project.add.mutate({ path: join(app, "packages/web"), agents: ["claude-code"] });
    await trpc.project.add.mutate({ path: scratch });

    expect(await trpc.project.list.query()).toEqual([
      { path: app, name: "app", exists: true, agents: ["claude-code"] },
      // Nothing detected: the `.agents` convention is the least that gets written.
      { path: scratch, name: "notes", exists: true, agents: ["agents"] },
    ]);
  });

  test("Add folder… on a folder that isn't there fails with PathGone", async () => {
    const { home, trpc } = await setup();

    await expect(trpc.project.add.mutate({ path: join(home, "nowhere") })).rejects.toMatchObject({
      data: { tag: "PathGone" },
    });
  });

  test("the Agent picker writes .agents/skills, plus .claude/skills when Claude Code is chosen", async () => {
    const { home, libraryHome, trpc } = await setup();
    const app = await gitRepo(home, "code/app");
    await mkdir(join(app, ".claude"));
    const added = await trpc.project.add.mutate({ path: app });
    expect(added.agentOptions).toEqual([
      { id: "claude-code", name: "Claude Code", detected: true, folder: ".claude/skills" },
      { id: "cursor", name: "Cursor", detected: false, folder: ".agents/skills" },
      { id: "opencode", name: "OpenCode", detected: false, folder: ".agents/skills" },
      { id: "codex", name: "Codex", detected: false, folder: ".agents/skills" },
      { id: "agents", name: ".agents", detected: false, folder: ".agents/skills" },
    ]);
    expect(added).toMatchObject({ agents: ["claude-code"], folders: [".claude/skills"] });

    const both = await trpc.project.setAgents.mutate({ path: app, agents: ["codex", "claude-code"] });
    expect(both).toMatchObject({ agents: ["claude-code", "codex"], folders: [".agents/skills", ".claude/skills"] });

    const codexOnly = await trpc.project.setAgents.mutate({ path: app, agents: ["codex"] });
    expect(codexOnly.folders).toEqual([".agents/skills"]);
    expect(JSON.parse(await readFile(join(libraryHome, "projects.json"), "utf8"))).toEqual({
      projects: { [app]: { agents: ["codex"] } },
    });
  });

  test("an unknown Project fails with ProjectNotFound", async () => {
    const { home, trpc } = await setup();

    await expect(trpc.project.get.query({ path: join(home, "code/app") })).rejects.toMatchObject({
      data: { tag: "ProjectNotFound" },
    });
  });
});

describe("the Scan of confirmed Projects", () => {
  test("reads their skill folders, and only theirs", async () => {
    const { home, fixture, trpc } = await setup();
    const app = await gitRepo(home, "code/app");
    const other = await gitRepo(home, "code/other");
    await fixture.skill(join(app, ".agents/skills/pdf"), { name: "pdf", description: "Work with PDFs" });
    await fixture.skill("code/shared/lint", { name: "lint" });
    await fixture.link(join(app, ".claude/skills/lint"), "code/shared/lint");
    await fixture.skill(join(other, ".agents/skills/unseen"), { name: "unseen" });
    await trpc.project.add.mutate({ path: app });
    expect((await trpc.project.get.query({ path: app })).skills).toBeNull();

    await trpc.scan.run.mutate();

    expect((await trpc.project.get.query({ path: app })).skills).toEqual([
      {
        name: "pdf",
        description: "Work with PDFs",
        folder: ".agents/skills",
        path: join(app, ".agents/skills/pdf"),
        realPath: join(app, ".agents/skills/pdf"),
        symlink: false,
      },
      {
        name: "lint",
        description: "",
        folder: ".claude/skills",
        path: join(app, ".claude/skills/lint"),
        realPath: join(home, "code/shared/lint"),
        symlink: true,
      },
    ]);
    // Project Skills are not Global Skills.
    expect((await trpc.inbox.list.query()).globalSkills).toEqual([]);
  });
});

describe("a Project whose folder is gone", () => {
  test("is flagged, and Locate… points it at the new folder, keeping its Agents", async () => {
    const { home, libraryHome, trpc } = await setup();
    const app = await gitRepo(home, "code/app");
    await trpc.project.add.mutate({ path: app, agents: ["claude-code", "cursor"] });
    const moved = join(home, "work/app");
    await mkdir(join(home, "work"));
    await rename(app, moved);

    expect(await trpc.project.list.query()).toEqual([
      { path: app, name: "app", exists: false, agents: ["claude-code", "cursor"] },
    ]);
    expect(await trpc.project.get.query({ path: app })).toMatchObject({ exists: false });

    const located = await trpc.project.locate.mutate({ path: app, newPath: moved });

    expect(located).toMatchObject({ path: moved, exists: true, agents: ["claude-code", "cursor"] });
    expect(JSON.parse(await readFile(join(libraryHome, "projects.json"), "utf8"))).toEqual({
      projects: { [moved]: { agents: ["claude-code", "cursor"] } },
    });
    expect((await trpc.activity.list.query()).entries[0]).toMatchObject({
      action: "project.locate",
      subjects: [
        { kind: "project", id: app },
        { kind: "project", id: moved },
      ],
    });
  });

  test("Locate… onto another Project's folder fails with ProjectExists", async () => {
    const { home, trpc } = await setup();
    const app = await gitRepo(home, "code/app");
    const api = await gitRepo(home, "code/api");
    await trpc.project.add.mutate({ path: app });
    await trpc.project.add.mutate({ path: api });

    await expect(trpc.project.locate.mutate({ path: app, newPath: api })).rejects.toMatchObject({
      data: { tag: "ProjectExists" },
    });
  });

  test("Remove forgets it and touches nothing on disk", async () => {
    const { home, libraryHome, trpc } = await setup();
    const app = await gitRepo(home, "code/app");
    await trpc.project.add.mutate({ path: app });
    await rm(app, { recursive: true });

    await trpc.project.remove.mutate({ path: app });

    expect(await trpc.project.list.query()).toEqual([]);
    expect(JSON.parse(await readFile(join(libraryHome, "projects.json"), "utf8"))).toEqual({ projects: {} });
  });
});

describe("projects.json hand edits", () => {
  test("an invalid edit is held and reported, and the last good Projects keep serving", async () => {
    const { home, libraryHome, trpc } = await setup();
    const app = await gitRepo(home, "code/app");
    await trpc.project.add.mutate({ path: app, agents: ["codex"] });

    await writeFile(join(libraryHome, "projects.json"), JSON.stringify({ projects: { [app]: { agents: ["vim"] } } }));

    await expect
      .poll(() => trpc.ownedFiles.problems.query())
      .toEqual([expect.objectContaining({ file: "projects.json" })]);
    expect(await trpc.project.list.query()).toEqual([expect.objectContaining({ path: app, agents: ["codex"] })]);
    await expect(trpc.project.setAgents.mutate({ path: app, agents: ["cursor"] })).rejects.toMatchObject({
      data: { tag: "InvalidOwnedFile" },
    });
  });
});
