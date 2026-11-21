// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${secret:…}` is an MCP reference, not a template.
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { memorySecrets } from "../src/index";
import { agentHome, gitRepo } from "./agent-home";
import { bootCore, connect, connectAgent, fakeClock, fakeNotifier, tempHome } from "./harness";

const start = new Date("2026-11-21T10:00:00.000Z");
const hours = (n: number) => new Date(start.getTime() + n * 60 * 60 * 1000);

const SECRET_VALUE = "ghp_never_shown_to_agents";
const github = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:github.TOKEN}" },
};

/** Library Skills written before the core starts. */
const seedLibrary = async (libraryHome: string, keys: string[]) => {
  const fixture = agentHome(libraryHome);
  const entries: Record<string, unknown> = {};
  for (const key of keys) {
    await fixture.skill(join(libraryHome, "skills", key), { description: `About ${key}` });
    entries[key] = { source: key, sourceType: "local", computedHash: "0".repeat(64) };
  }
  await mkdir(libraryHome, { recursive: true });
  await writeFile(join(libraryHome, "library-lock.json"), JSON.stringify({ version: 1, skills: entries }));
};

/**
 * A core with an app client and a fake Agent client (`mcp`, "claude-code")
 * over the real WebSocket, a controllable clock and a recording notifier.
 */
const setup = async ({ waitMs = 50, headless = false } = {}) => {
  const { home, libraryHome } = await tempHome();
  await seedLibrary(libraryHome, ["local/pdf", "local/docx"]);
  await mkdir(join(libraryHome, "mcp"), { recursive: true });
  await writeFile(join(libraryHome, "mcp/github.json"), JSON.stringify(github));
  const clock = fakeClock(start);
  const notifier = { ...fakeNotifier(), available: () => !headless };
  const secrets = memorySecrets(new Map([["github.TOKEN", SECRET_VALUE]]));
  const core = await bootCore(
    { HOME: home, DARK_MATTER_HOME: libraryHome },
    { clock, notifier, secrets, requestWaitMs: waitMs },
  );
  const app = connect(core).trpc;
  const agent = connectAgent(core).trpc;
  const project = async (dir: string, agents: AgentId[] = ["claude-code"]) => {
    const path = await gitRepo(home, dir);
    await app.project.add.mutate({ path, agents });
    return path;
  };
  /** The Agent's change, left pending (its wait is short), and the Request's id. */
  const pendingRequest = async (call: Promise<unknown>) => {
    const data = await failure(call);
    expect(data.tag).toBe("RequestPending");
    return data.request?.id as string;
  };
  return { home, libraryHome, clock, notifier, app, agent, project, pendingRequest };
};

const linkAt = (path: string) =>
  lstat(path).then(
    () => readlink(path),
    () => null,
  );
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
/** The tagged error (and its data) a call failed with. */
const failure = (call: Promise<unknown>) =>
  call.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: { data?: unknown }) => error.data as { tag: string; request?: { id: string; summary: string } },
  );

describe("Requests from a client other than the app (ADR-0006)", () => {
  test("an Agent's change without a Grant waits, then returns pending with its plan; it's in requests.json, the Inbox and a notification, and nothing is written", async () => {
    const { libraryHome, app, agent, project, notifier } = await setup();
    const path = await project("code/app");

    const pending = await failure(agent.project.addSkills.mutate({ skills: [{ path, key: "local/pdf" }] }));

    expect(pending).toMatchObject({
      tag: "RequestPending",
      request: { id: expect.any(String), summary: "Add local/pdf to app as a Link" },
    });
    const id = pending.request?.id as string;
    expect(await linkAt(join(path, ".claude/skills/pdf"))).toBeNull();
    const request = {
      id,
      client: "mcp",
      agent: "claude-code",
      operation: "project.addSkills",
      input: { skills: [{ path, key: "local/pdf" }] },
      projects: [path],
      summary: "Add local/pdf to app as a Link",
      reasons: ["noGrant"],
      createdAt: start.toISOString(),
      expiresAt: hours(24).toISOString(),
      status: "pending",
    };
    expect((await readJson(join(libraryHome, "requests.json"))).requests).toEqual({ [id]: request });
    const inbox = await app.inbox.list.query();
    const { input: _, ...listed } = request;
    expect(inbox.requests).toEqual([listed]);
    expect(inbox.count).toBe(1);
    expect(notifier.sent).toEqual([
      { title: "claude-code asks to change app", body: "Add local/pdf to app as a Link", path: "/inbox", request: id },
    ]);
  });

  test("the app's own calls pass straight through", async () => {
    const { app, project } = await setup();
    const path = await project("code/app");

    await app.project.addSkills.mutate({ skills: [{ path, key: "local/pdf" }] });

    expect(await app.requests.list.query()).toEqual([]);
  });

  test("Approve after the call stopped waiting applies it as the Agent; the Activity Log shows the Request and its outcome under the Agent", async () => {
    const { libraryHome, app, agent, project, pendingRequest } = await setup();
    const path = await project("code/app");
    const id = await pendingRequest(agent.project.addSkills.mutate({ skills: [{ path, key: "local/pdf" }] }));

    const approved = await app.requests.approve.mutate({ id });

    expect(approved).toMatchObject({ id, status: "applied", decidedAt: start.toISOString() });
    expect(await linkAt(join(path, ".claude/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
    expect((await app.inbox.list.query()).requests).toEqual([]);
    const { entries } = await app.activity.list.query({
      actions: ["request.create", "request.approve", "project.addSkills"],
    });
    expect(
      entries.map(({ client, agent: name, request, action, result }) => ({ client, name, request, action, result })),
    ).toEqual([
      { client: "mcp", name: "claude-code", request: id, action: "project.addSkills", result: "ok" },
      { client: "mcp", name: "claude-code", request: id, action: "request.approve", result: "ok" },
      { client: "mcp", name: "claude-code", request: id, action: "request.create", result: "ok" },
    ]);
  });

  test("Approve while the Agent's call is still waiting returns the result to that call", async () => {
    const { app, agent, project, notifier } = await setup({ waitMs: 10_000 });
    const path = await project("code/app");

    const call = agent.project.addSkills.mutate({ skills: [{ path, key: "local/pdf" }] });
    await expect.poll(() => notifier.sent.length).toBe(1);
    const id = notifier.sent[0]?.request as string;
    const approved = await app.requests.approve.mutate({ id });

    expect(approved.status).toBe("applied");
    expect(await call).toEqual([{ path, skills: [expect.objectContaining({ key: "local/pdf", on: true })] }]);
  });

  test("Deny tells a waiting call it was denied and writes nothing; a decided Request can't be decided again", async () => {
    const { app, agent, project, notifier } = await setup({ waitMs: 10_000 });
    const path = await project("code/app");

    const call = failure(agent.project.addSkills.mutate({ skills: [{ path, key: "local/pdf" }] }));
    await expect.poll(() => notifier.sent.length).toBe(1);
    const id = notifier.sent[0]?.request as string;
    expect(await app.requests.deny.mutate({ id })).toMatchObject({ status: "denied" });

    expect(await call).toMatchObject({ tag: "RequestDenied" });
    expect(await linkAt(join(path, ".claude/skills/pdf"))).toBeNull();
    expect(await failure(app.requests.approve.mutate({ id }))).toMatchObject({ tag: "RequestDecided" });
  });

  test("with only a headless core the Request waits in the Inbox at once", async () => {
    const { app, agent, project } = await setup({ waitMs: 60_000, headless: true });
    const path = await project("code/app");

    const pending = await failure(agent.project.setSkillOn.mutate({ path, key: "local/pdf", on: true }));

    expect(pending.tag).toBe("RequestPending");
    expect((await app.inbox.list.query()).requests).toHaveLength(1);
  });

  test("a Grant lets On/Off and adding or removing a Link through, recorded under the Agent", async () => {
    const { libraryHome, app, agent, project } = await setup();
    const path = await project("code/app");
    expect((await app.project.get.query({ path })).grant).toBe(false);

    expect((await app.project.setGrant.mutate({ path, grant: true })).grant).toBe(true);
    expect((await readJson(join(libraryHome, "projects.json"))).projects[path].grant).toBe(true);
    await agent.project.addSkills.mutate({ skills: [{ path, key: "local/pdf" }] });
    await agent.project.setSkillOn.mutate({ path, key: "local/pdf", on: false });
    await agent.project.setSkillOn.mutate({ path, key: "local/pdf", on: true });
    expect(await linkAt(join(path, ".claude/skills/pdf"))).toBe(join(libraryHome, "skills/local/pdf"));
    await agent.project.removeSkill.mutate({ path, key: "local/pdf" });

    expect(await linkAt(join(path, ".claude/skills/pdf"))).toBeNull();
    expect(await app.requests.list.query()).toEqual([]);
    const { entries } = await app.activity.list.query({ clients: ["mcp"] });
    expect(entries.map((entry) => [entry.action, entry.agent])).toEqual([
      ["project.removeSkill", "claude-code"],
      ["project.skillOn", "claude-code"],
      ["project.skillOff", "claude-code"],
      ["project.addSkills", "claude-code"],
    ]);

    await app.project.setGrant.mutate({ path, grant: false });
    expect((await readJson(join(libraryHome, "projects.json"))).projects[path]).not.toHaveProperty("grant");
    expect((await failure(agent.project.addSkills.mutate({ skills: [{ path, key: "local/pdf" }] }))).tag).toBe(
      "RequestPending",
    );
  });

  test("a Copy, a new or Shared MCP Server and an Import always ask, even with a Grant", async () => {
    const { app, agent, project } = await setup();
    const path = await project("code/app");
    await app.project.setGrant.mutate({ path, grant: true });

    const asks = async (call: Promise<unknown>) => {
      const data = await failure(call);
      expect(data.tag).toBe("RequestPending");
      return (await app.requests.get.query({ id: data.request?.id as string })).reasons;
    };
    expect(await asks(agent.project.addSkills.mutate({ skills: [{ path, key: "local/pdf", mode: "copy" }] }))).toEqual([
      "copy",
    ]);
    expect(await asks(agent.project.addMcpServers.mutate({ servers: [{ path, name: "github" }] }))).toEqual([
      "mcpServer",
    ]);
    expect(
      await asks(agent.project.addMcpServers.mutate({ servers: [{ path, name: "github", mode: "shared" }] })),
    ).toEqual(["mcpServer", "sharedMcpServer"]);
    expect(
      await asks(agent.importer.import.mutate({ input: "acme/skills", commit: "a".repeat(40), paths: ["skills/pdf"] })),
    ).toEqual(["import"]);
    expect(await asks(agent.skillsSh.get.mutate({ id: "acme/skills/pdf" }))).toEqual(["import"]);
    expect((await app.inbox.list.query()).requests.map((request) => request.summary).sort()).toEqual([
      "Add local/pdf to app as a Copy",
      "Add the MCP Server github to app as Personal",
      "Add the MCP Server github to app as Shared",
      "Get acme/skills/pdf from skills.sh",
      "Import 1 Skill from acme/skills",
    ]);
  });

  test("a Grant never covers re-adding an Off Copy or switching a Copy to a Link, even without a mode in the call", async () => {
    const { app, agent, project } = await setup();
    const path = await project("code/app");
    await app.project.setGrant.mutate({ path, grant: true });
    await app.project.addSkills.mutate({ skills: [{ path, key: "local/pdf", mode: "copy" }] });
    await app.project.setSkillOn.mutate({ path, key: "local/pdf", on: false });

    const asks = async (call: Promise<unknown>) => {
      const data = await failure(call);
      expect(data.tag).toBe("RequestPending");
      const request = await app.requests.get.query({ id: data.request?.id as string });
      return { reasons: request.reasons, summary: request.summary };
    };
    expect(await asks(agent.project.addSkills.mutate({ skills: [{ path, key: "local/pdf" }] }))).toEqual({
      reasons: ["copy"],
      summary: "Add local/pdf to app as a Copy",
    });
    expect(
      await asks(agent.project.addSkills.mutate({ skills: [{ path, key: "local/pdf", mode: "link" }] })),
    ).toEqual({ reasons: ["copy"], summary: "Switch local/pdf in app from a Copy to a Link" });
    expect((await app.project.skills.query({ path })).find((skill) => skill.key === "local/pdf")).toMatchObject({
      mode: "copy",
      on: false,
    });
  });

  test("app-only operations are refused for an Agent, whatever the Grant", async () => {
    const { app, agent, project } = await setup();
    const path = await project("code/app");
    await app.project.setGrant.mutate({ path, grant: true });

    for (const call of [
      agent.skill.delete.mutate({ key: "local/pdf" }),
      agent.project.setGrant.mutate({ path, grant: true }),
      agent.mcp.setSecret.mutate({ name: "github.TOKEN", value: "x" }),
      agent.settings.updatePreferences.mutate({ startAtLogin: false }),
      agent.project.add.mutate({ path }),
      agent.requests.approve.mutate({ id: "anything" }),
    ]) {
      expect(await failure(call)).toMatchObject({ tag: "AppOnly" });
    }
    expect((await app.library.list.query()).skills.map((skill) => skill.key)).toContain("local/pdf");
  });

  test("reads are free for an Agent and never carry a Secret's value", async () => {
    const { app, agent, project } = await setup();
    const path = await project("code/app");
    await app.project.addMcpServers.mutate({ servers: [{ path, name: "github" }] });

    const reads = await Promise.all([
      agent.mcp.list.query(),
      agent.project.mcpServers.query({ path }),
      agent.project.repoMcpServers.query({ path }),
      agent.project.get.query({ path }),
      agent.library.list.query(),
      agent.inbox.list.query(),
      agent.activity.list.query({}),
      agent.scan.run.mutate(),
    ]);

    expect(JSON.stringify(reads)).not.toContain(SECRET_VALUE);
    expect(await app.requests.list.query()).toEqual([]);
  });

  test("a pending Request expires after 24 hours; it's recorded, leaves the Inbox, can't be approved, and is forgotten a day later", async () => {
    const { app, agent, project, clock, pendingRequest } = await setup();
    const path = await project("code/app");
    const id = await pendingRequest(agent.project.addSkills.mutate({ skills: [{ path, key: "local/pdf" }] }));

    clock.set(hours(24));

    await expect.poll(async () => (await app.requests.get.query({ id })).status).toBe("expired");
    expect((await app.inbox.list.query()).requests).toEqual([]);
    expect(await failure(app.requests.approve.mutate({ id }))).toMatchObject({ tag: "RequestDecided" });
    const { entries } = await app.activity.list.query({ actions: ["request.expire"] });
    expect(entries).toMatchObject([{ client: "mcp", agent: "claude-code", request: id }]);

    clock.set(hours(48));
    await expect.poll(async () => (await app.requests.list.query()).length).toBe(0);
  });

  test("an approved Request is re-validated against the current state: if it no longer applies it fails and changes nothing", async () => {
    const { app, agent, project, pendingRequest } = await setup();
    const path = await project("code/app");
    const id = await pendingRequest(agent.project.addSkills.mutate({ skills: [{ path, key: "local/pdf" }] }));
    await app.skill.delete.mutate({ key: "local/pdf" });

    const approved = await app.requests.approve.mutate({ id });

    expect(approved).toMatchObject({ status: "failed", error: { tag: "SkillNotFound" } });
    expect(await linkAt(join(path, ".claude/skills/pdf"))).toBeNull();
    expect((await app.project.skills.query({ path })).map((skill) => skill.key)).toEqual([]);
  });

  test("an Agent can only ask about confirmed Projects", async () => {
    const { home, agent } = await setup();
    const elsewhere = await gitRepo(home, "code/other");

    expect(
      await failure(agent.project.addSkills.mutate({ skills: [{ path: elsewhere, key: "local/pdf" }] })),
    ).toMatchObject({ tag: "ProjectNotFound" });
  });
});
