import { execFileSync } from "node:child_process";
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId, CoreEvent, Domain } from "@dark-matter/contracts";
import type { CoreClient } from "@dark-matter/contracts/client";
import { describe, expect, test } from "vitest";
import { agentHome, gitRepo } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

const GITHUB_ENTRY = {
  source: "acme/skills",
  sourceType: "github",
  ref: "main",
  commit: "1111111111111111111111111111111111111111",
  computedHash: "0".repeat(64),
};

/** Library Skills written before the core starts: folders under `skills/` plus their Library Lock entries. */
const seedLibrary = async (libraryHome: string, keys: string[]) => {
  const fixture = agentHome(libraryHome);
  const entries: Record<string, unknown> = {};
  for (const key of keys) {
    await fixture.skill(join(libraryHome, "skills", key), { description: `About ${key}` });
    entries[key] = key.startsWith("local/")
      ? { source: key, sourceType: "local", computedHash: "0".repeat(64) }
      : { ...GITHUB_ENTRY, skillPath: `skills/${key.split("/").at(-1)}/SKILL.md` };
  }
  await mkdir(libraryHome, { recursive: true });
  await writeFile(join(libraryHome, "library-lock.json"), JSON.stringify({ version: 1, skills: entries }));
};

/** Every `invalidate` event pushed from now on. */
const recordEvents = async (trpc: CoreClient["trpc"]) => {
  const events: CoreEvent[] = [];
  let started = false;
  trpc.events.subscribe(undefined, { onStarted: () => (started = true), onData: (event) => events.push(event) });
  await expect.poll(() => started).toBe(true);
  return {
    events,
    saw: (domain: Domain) => events.some((event) => event.domains.includes(domain)),
    clear: () => events.splice(0),
  };
};

const setup = async (keys: string[] = ["local/pdf"]) => {
  const { home, libraryHome } = await tempHome();
  await seedLibrary(libraryHome, keys);
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome });
  const { trpc } = connect(core);
  /** A git repo confirmed as a Project with these Agents. */
  const project = async (dir: string, agents: AgentId[]) => {
    const path = await gitRepo(home, dir);
    await trpc.project.add.mutate({ path, agents });
    return path;
  };
  const drift = async () => (await trpc.inbox.list.query()).drift.flatMap((group) => group.findings);
  return { home, libraryHome, trpc, project, drift, fixture: agentHome(home) };
};

const linkAt = (path: string) =>
  lstat(path).then(
    async (info) => (info.isSymbolicLink() ? readlink(path) : `not a symlink (${info.isDirectory() ? "dir" : "file"})`),
    () => null,
  );
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

describe("drift: a hand-deleted Link", () => {
  test("shows in the Inbox with Restore or Accept, pushed live", async () => {
    const { trpc, project, drift } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });
    const { saw } = await recordEvents(trpc);

    await rm(join(app, ".claude/skills/pdf"));

    await expect.poll(() => saw("inbox"), { timeout: 5000 }).toBe(true);
    expect(await drift()).toEqual([
      {
        id: `drift:${app}:local/pdf`,
        kind: "missing",
        project: app,
        key: "local/pdf",
        name: "pdf",
        mode: "link",
        paths: [".claude/skills/pdf"],
        actions: ["restore", "accept"],
      },
    ]);
    expect((await trpc.inbox.list.query()).count).toBe(1);
  });

  test("Restore re-creates the Link and clears the finding", async () => {
    const { libraryHome, trpc, project, drift } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });
    await rm(join(app, ".claude/skills/pdf"));
    await expect.poll(async () => (await drift()).length, { timeout: 5000 }).toBe(1);

    await trpc.drift.restore.mutate({ id: `drift:${app}:local/pdf` });

    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
    expect(await drift()).toEqual([]);
    const [entry] = (await trpc.activity.list.query({})).entries;
    expect(entry).toMatchObject({ action: "drift.restore", result: "ok" });
  });

  test("Accept keeps the Project Skill Off in projects.json and removes its other Links", async () => {
    const { libraryHome, trpc, project, drift } = await setup();
    const app = await project("code/app", ["claude-code", "codex"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });
    await rm(join(app, ".claude/skills/pdf"));
    await expect.poll(async () => (await drift()).length, { timeout: 5000 }).toBe(1);

    await trpc.drift.accept.mutate({ id: `drift:${app}:local/pdf` });

    expect((await readJson(join(libraryHome, "projects.json"))).projects[app].skills).toEqual({
      "local/pdf": { mode: "link", on: false },
    });
    expect(await linkAt(join(app, ".agents/skills/pdf"))).toBeNull();
    expect(await drift()).toEqual([]);
  });

  test("an unknown finding or an action it doesn't offer is refused", async () => {
    const { trpc } = await setup();
    await expect(trpc.drift.restore.mutate({ id: "drift:/nowhere:local/pdf" })).rejects.toMatchObject({
      data: { tag: "UnknownFinding" },
    });
  });
});

describe("drift: npx skills overwrote a Link", () => {
  const overwrite = async (fixture: ReturnType<typeof agentHome>, at: string) => {
    await rm(at);
    await fixture.skill(at, { name: "pdf", description: "the skills CLI's copy" });
  };

  test("is a replaced finding; Restore moves what's there to trash/ and re-links", async () => {
    const { libraryHome, trpc, project, drift, fixture } = await setup();
    const app = await project("code/app", ["claude-code"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });

    await overwrite(fixture, join(app, ".claude/skills/pdf"));

    await expect
      .poll(drift, { timeout: 5000 })
      .toEqual([
        expect.objectContaining({ kind: "replaced", paths: [".claude/skills/pdf"], actions: ["restore", "accept"] }),
      ]);
    await trpc.drift.restore.mutate({ id: `drift:${app}:local/pdf` });

    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
    const [stamp] = await readdir(join(libraryHome, "trash"));
    expect(
      await readFile(join(libraryHome, "trash", stamp ?? "", "app/.claude/skills/pdf/SKILL.md"), "utf8"),
    ).toContain("the skills CLI's copy");
    expect(await drift()).toEqual([]);
  });

  test("Accept forgets the Project Skill and leaves the new folder alone", async () => {
    const { libraryHome, trpc, project, drift, fixture } = await setup();
    const app = await project("code/app", ["claude-code"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });
    await overwrite(fixture, join(app, ".claude/skills/pdf"));
    await expect.poll(async () => (await drift()).length, { timeout: 5000 }).toBe(1);

    await trpc.drift.accept.mutate({ id: `drift:${app}:local/pdf` });

    expect((await readJson(join(libraryHome, "projects.json"))).projects[app].skills).toEqual({});
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe("not a symlink (dir)");
    expect(await drift()).toEqual([]);
  });
});

describe("drift: a teammate's skills-lock.json change", () => {
  test("a new lock entry is offered as a Copy to add; Accept keeps the committed folder as the Copy", async () => {
    const { libraryHome, trpc, project, drift, fixture } = await setup(["acme/skills/pdf"]);
    const app = await project("code/app", ["claude-code"]);

    // A teammate committed a Copy with the skills CLI; this is what `git pull` brings.
    await fixture.skill(join(app, ".agents/skills/pdf"), { description: "About acme/skills/pdf" });
    const { computeSkillFolderHash } = await import("../src/skill-hash");
    const entry = { ...GITHUB_ENTRY, skillPath: "skills/pdf/SKILL.md" };
    const computedHash = await computeSkillFolderHash(join(app, ".agents/skills/pdf"));
    await writeFile(
      join(app, "skills-lock.json"),
      `${JSON.stringify({ version: 2, skills: { pdf: { ...entry, computedHash } } }, null, 2)}\n`,
    );

    await expect.poll(drift, { timeout: 5000 }).toEqual([
      {
        id: `drift:${app}:lock:pdf`,
        kind: "lockAdded",
        project: app,
        key: "acme/skills/pdf",
        name: "pdf",
        mode: "copy",
        paths: ["skills-lock.json"],
        actions: ["accept"],
      },
    ]);
    await trpc.drift.accept.mutate({ id: `drift:${app}:lock:pdf` });

    expect((await readJson(join(libraryHome, "projects.json"))).projects[app].skills).toEqual({
      "acme/skills/pdf": { mode: "copy", on: true },
    });
    expect(await readFile(join(app, ".agents/skills/pdf/SKILL.md"), "utf8")).toContain("About acme/skills/pdf");
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBe("../../.agents/skills/pdf");
    expect(await drift()).toEqual([]);
  });

  const removedByTeammate = async () => {
    const it = await setup(["acme/skills/pdf"]);
    const app = await it.project("code/app", ["claude-code"]);
    await it.trpc.project.addSkills.mutate({ skills: [{ path: app, key: "acme/skills/pdf", mode: "copy" }] });
    git(app, "add", "-A");
    git(app, "commit", "-qm", "add pdf");
    // A teammate removed the Copy; `git pull` brings the removal.
    await rm(join(app, ".agents/skills/pdf"), { recursive: true });
    await writeFile(join(app, "skills-lock.json"), `${JSON.stringify({ version: 2, skills: {} }, null, 2)}\n`);
    await expect
      .poll(it.drift, { timeout: 5000 })
      .toEqual([
        expect.objectContaining({ kind: "lockRemoved", key: "acme/skills/pdf", actions: ["restore", "accept"] }),
      ]);
    return { ...it, app };
  };

  test("a removed lock entry is offered as a Copy to remove; Accept forgets it and its own symlink", async () => {
    const { libraryHome, trpc, app, drift } = await removedByTeammate();

    await trpc.drift.accept.mutate({ id: `drift:${app}:acme/skills/pdf` });

    expect((await readJson(join(libraryHome, "projects.json"))).projects[app].skills).toEqual({});
    expect(await linkAt(join(app, ".claude/skills/pdf"))).toBeNull();
    expect(await drift()).toEqual([]);
  });

  test("Restore puts the Copy and its lock entry back", async () => {
    const { trpc, app, drift } = await removedByTeammate();

    await trpc.drift.restore.mutate({ id: `drift:${app}:acme/skills/pdf` });

    expect(Object.keys((await readJson(join(app, "skills-lock.json"))).skills)).toEqual(["pdf"]);
    expect((await lstat(join(app, ".agents/skills/pdf"))).isDirectory()).toBe(true);
    expect(await drift()).toEqual([]);
  });
});

describe("live refresh", () => {
  test("a Project's folder disappearing shows live; Accept forgets the Project", async () => {
    const { libraryHome, trpc, project, drift } = await setup();
    const app = await project("code/app", ["claude-code"]);
    const { saw } = await recordEvents(trpc);

    await rename(app, `${app}-moved`);

    await expect.poll(() => saw("project"), { timeout: 5000 }).toBe(true);
    expect((await trpc.project.list.query()).find((summary) => summary.path === app)).toMatchObject({ exists: false });
    expect(await drift()).toEqual([
      {
        id: `drift:${app}`,
        kind: "projectGone",
        project: app,
        key: null,
        name: null,
        mode: null,
        paths: [],
        actions: ["accept"],
      },
    ]);
    await trpc.drift.accept.mutate({ id: `drift:${app}` });
    expect((await readJson(join(libraryHome, "projects.json"))).projects).toEqual({});
  });

  test("editing a Library Skill by hand marks it Modified, pushed live", async () => {
    const { libraryHome, trpc } = await setup(["acme/skills/pdf"]);
    const { computeSkillFolderHash } = await import("../src/skill-hash");
    const folder = join(libraryHome, "skills/acme/skills/pdf");
    const lock = await readJson(join(libraryHome, "library-lock.json"));
    lock.skills["acme/skills/pdf"].computedHash = await computeSkillFolderHash(folder);
    await writeFile(join(libraryHome, "library-lock.json"), JSON.stringify(lock));
    await expect.poll(async () => (await trpc.library.list.query()).skills[0]?.modified, { timeout: 5000 }).toBe(false);
    const { saw } = await recordEvents(trpc);

    await writeFile(join(folder, "notes.md"), "mine\n");

    await expect.poll(() => saw("library"), { timeout: 5000 }).toBe(true);
    expect((await trpc.library.list.query()).skills[0]?.modified).toBe(true);
    await rm(join(folder, "notes.md"));
    await expect.poll(async () => (await trpc.library.list.query()).skills[0]?.modified, { timeout: 5000 }).toBe(false);
  });

  test("a hand edit to an MCP definition is validated: valid ones apply, invalid ones are held", async () => {
    const { libraryHome, trpc } = await setup();
    const file = join(libraryHome, "mcp/github.json");
    await mkdir(join(libraryHome, "mcp"), { recursive: true });
    const { saw, clear } = await recordEvents(trpc);

    await writeFile(file, JSON.stringify({ transport: "http", url: "https://example.com/mcp" }));

    await expect.poll(() => saw("mcp"), { timeout: 5000 }).toBe(true);
    expect((await trpc.mcp.list.query()).servers).toEqual([
      expect.objectContaining({
        name: "github",
        definition: { transport: "http", url: "https://example.com/mcp" },
        problem: null,
      }),
    ]);
    clear();

    await writeFile(file, '{ "transport": "carrier-pigeon" }');

    await expect.poll(() => saw("mcp"), { timeout: 5000 }).toBe(true);
    expect((await trpc.mcp.list.query()).servers).toEqual([
      expect.objectContaining({
        name: "github",
        definition: { transport: "http", url: "https://example.com/mcp" },
        problem: expect.any(String),
      }),
    ]);
    expect(await readFile(file, "utf8")).toBe('{ "transport": "carrier-pigeon" }');
  });

  test("after the first Scan, a new Global Skill in an Agent's folder reaches the Inbox without Scan now", async () => {
    const { home, trpc, fixture } = await setup();
    await mkdir(join(home, ".claude/skills"), { recursive: true });
    await trpc.scan.run.mutate();
    expect((await trpc.inbox.list.query()).globalSkills).toEqual([]);

    await fixture.skill(join(home, ".claude/skills/review"), { name: "review", description: "Reviews code" });

    await expect
      .poll(
        async () => (await trpc.inbox.list.query()).globalSkills.flatMap((group) => group.findings.map((f) => f.name)),
        {
          timeout: 5000,
        },
      )
      .toEqual(["review"]);
    // The poll waits up to 5 s, as long as Vitest's default test timeout.
  }, 15_000);

  test("a burst of changes is debounced into a few events", async () => {
    const { trpc, project, drift } = await setup();
    const app = await project("code/app", ["claude-code"]);
    await mkdir(join(app, ".claude/skills"), { recursive: true });
    const { events } = await recordEvents(trpc);

    for (let i = 0; i < 40; i += 1) await symlink(join(app, "nowhere"), join(app, `.claude/skills/x${i}`));

    await expect.poll(() => events.length, { timeout: 5000 }).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const projectEvents = events.filter(
      (event) => event.domains.includes("project") && event.domains.includes("inbox"),
    );
    expect(projectEvents.length).toBeLessThanOrEqual(3);
    expect(await drift()).toEqual([]);
  });
});
