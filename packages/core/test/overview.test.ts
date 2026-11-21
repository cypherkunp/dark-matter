import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId, Domain } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { agentHome, gitRepo } from "./agent-home";
import { bootCore, connect, fakeClock, tempHome } from "./harness";

const GITHUB_ENTRY = {
  source: "acme/skills",
  sourceType: "github",
  ref: "main",
  commit: "1111111111111111111111111111111111111111",
  computedHash: "0".repeat(64),
};

/** Library Skills written before the core starts, keyed by Library key, with their SKILL.md `name`. */
const seedLibrary = async (libraryHome: string, skills: Record<string, string>) => {
  const fixture = agentHome(libraryHome);
  const entries: Record<string, unknown> = {};
  for (const [key, name] of Object.entries(skills)) {
    await fixture.skill(join(libraryHome, "skills", key), { name, description: `About ${key}` });
    entries[key] = { ...GITHUB_ENTRY, skillPath: `skills/${name}/SKILL.md` };
  }
  await mkdir(libraryHome, { recursive: true });
  await writeFile(join(libraryHome, "library-lock.json"), JSON.stringify({ version: 1, skills: entries }));
};

const setup = async (skills: Record<string, string> = { "acme/skills/pdf": "pdf" }, start = new Date()) => {
  const { home, libraryHome } = await tempHome();
  await seedLibrary(libraryHome, skills);
  const clock = fakeClock(start);
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }, { clock });
  const { trpc } = connect(core);
  const project = async (dir: string, agents: AgentId[] = ["codex"]) => {
    const path = await gitRepo(home, dir);
    await trpc.project.add.mutate({ path, agents });
    return path;
  };
  return { home, libraryHome, trpc, project, clock, fixture: agentHome(home) };
};

describe("the overview stat cards", () => {
  test("count Project Skills On, Global Skills found, outdated Copies and Name Conflicts, each linking to where it's resolved", async () => {
    const { libraryHome, trpc, project, fixture } = await setup({
      "acme/skills/pdf": "pdf",
      "acme/skills/docx": "docx",
      "acme/tools/xlsx": "xlsx",
      "acme/other/xlsx": "xlsx",
    });
    const app = await project("code/app");
    const api = await project("code/api");
    await trpc.project.addSkills.mutate({
      skills: [
        { path: app, key: "acme/skills/pdf" },
        { path: app, key: "acme/skills/docx", mode: "copy" },
        { path: api, key: "acme/skills/pdf" },
        { path: api, key: "acme/tools/xlsx" },
      ],
    });
    await trpc.project.setSkillOn.mutate({ path: api, key: "acme/skills/pdf", on: false });
    await trpc.project.addSkills.mutate({ skills: [{ path: api, key: "acme/other/xlsx" }] });
    await writeFile(join(libraryHome, "skills/acme/skills/docx/extra.md"), "new upstream file\n");
    await fixture.skill(".claude/skills/review", { name: "review" });
    await fixture.skill(".agents/skills/lint", { name: "lint" });

    expect((await trpc.overview.get.query()).stats.globalSkills).toEqual({ count: null, path: "/inbox" });
    await trpc.scan.run.mutate();

    expect((await trpc.overview.get.query()).stats).toEqual({
      projectSkillsOn: { count: 2, path: "/library" },
      globalSkills: { count: 2, path: "/inbox" },
      outdated: { count: 1, path: `/project?path=${encodeURIComponent(app)}` },
      nameConflicts: { count: 1, path: `/project?path=${encodeURIComponent(api)}` },
    });
  });
});

describe("the overview alerts panel", () => {
  test("surfaces Inbox groups and drift with a subject, the issue, a detail line and when it was first seen", async () => {
    const start = new Date("2026-11-20T09:00:00.000Z");
    const { trpc, project, fixture, clock } = await setup({ "acme/skills/pdf": "pdf" }, start);
    const app = await project("code/app", ["claude-code"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "acme/skills/pdf" }] });
    await fixture.skill(".claude/skills/review", { name: "review" });
    await fixture.skill(".claude/skills/lint", { name: "lint" });
    await trpc.scan.run.mutate();
    expect((await trpc.overview.get.query()).alerts).toEqual([
      {
        id: "global-skills:~/.claude/skills",
        subject: "~/.claude/skills",
        issue: "2 Global Skills found",
        detail: "lint, review",
        firstSeenAt: start.toISOString(),
        path: "/inbox",
      },
    ]);

    const later = new Date("2026-11-20T10:00:00.000Z");
    clock.set(later);
    await rm(join(app, ".claude/skills/pdf"));

    await expect
      .poll(async () => (await trpc.overview.get.query()).alerts, { timeout: 5000 })
      .toEqual([
        {
          id: `drift:${app}:acme/skills/pdf`,
          subject: "app",
          issue: "pdf Link deleted",
          detail: ".claude/skills/pdf",
          firstSeenAt: later.toISOString(),
          path: "/inbox",
        },
        expect.objectContaining({ id: "global-skills:~/.claude/skills", firstSeenAt: start.toISOString() }),
      ]);
  }, 15_000);

  test("a finding that went away is new again when it comes back; ignored findings leave the panel", async () => {
    const start = new Date("2026-11-20T09:00:00.000Z");
    const { home, trpc, fixture, clock } = await setup({}, start);
    await fixture.skill(".agents/skills/pdf", { name: "pdf" });
    await trpc.scan.run.mutate();
    expect((await trpc.overview.get.query()).alerts.map((alert) => alert.firstSeenAt)).toEqual([start.toISOString()]);

    await rm(join(home, ".agents/skills/pdf"), { recursive: true });
    await trpc.scan.run.mutate();
    expect((await trpc.overview.get.query()).alerts).toEqual([]);
    const later = new Date("2026-11-21T09:00:00.000Z");
    clock.set(later);
    await fixture.skill(".agents/skills/pdf", { name: "pdf" });
    await trpc.scan.run.mutate();
    expect((await trpc.overview.get.query()).alerts.map((alert) => alert.firstSeenAt)).toEqual([later.toISOString()]);

    await trpc.inbox.ignore.mutate({ id: "global-skill:~/.agents/skills/pdf" });
    expect((await trpc.overview.get.query()).alerts).toEqual([]);
  });
});

describe("the overview stays live", () => {
  test("a hand-deleted Link, a Scan and an Ignore each push an overview invalidation", async () => {
    const { trpc, project, fixture } = await setup();
    const app = await project("code/app", ["claude-code"]);
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "acme/skills/pdf" }] });
    const seen: Domain[][] = [];
    let started = false;
    trpc.events.subscribe(undefined, {
      onStarted: () => (started = true),
      onData: (event) => seen.push(event.domains),
    });
    await expect.poll(() => started).toBe(true);
    const sawOverview = () => seen.some((domains) => domains.includes("overview"));

    await rm(join(app, ".claude/skills/pdf"));
    await expect.poll(sawOverview, { timeout: 5000 }).toBe(true);
    expect((await trpc.overview.get.query()).alerts.map((alert) => alert.issue)).toEqual(["pdf Link deleted"]);

    seen.splice(0);
    await fixture.skill(".agents/skills/lint", { name: "lint" });
    await trpc.scan.run.mutate();
    await expect.poll(sawOverview).toBe(true);

    seen.splice(0);
    await trpc.inbox.ignore.mutate({ id: "global-skill:~/.agents/skills/lint" });
    await expect.poll(sawOverview).toBe(true);
  }, 15_000);
});
