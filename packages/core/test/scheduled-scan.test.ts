import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentHome, gitRepo, snapshotTree } from "./agent-home";
import { bootCore, connect, fakeClock, fakeNotifier, localTime, tempHome } from "./harness";

const setup = async (start: Date) => {
  const { home, libraryHome } = await tempHome();
  const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
  const clock = fakeClock(start);
  const notifier = fakeNotifier();
  const core = await bootCore(env, { clock, notifier });
  return { home, env, clock, notifier, fixture: agentHome(home), trpc: connect(core).trpc };
};

/** Lets anything a clock change started finish, so a test can check it didn't happen. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 150));

type Trpc = Awaited<ReturnType<typeof setup>>["trpc"];

const scheduledScans = async (trpc: Trpc) =>
  (await trpc.activity.list.query()).entries.filter(
    (entry) => entry.client === "scheduled-scan" && entry.action === "scan.run",
  );

describe("the Scheduled Scan", () => {
  test("runs daily at 09:00 and records the Scheduled Scan as its client", async () => {
    const { clock, trpc } = await setup(localTime(20, 8));
    await trpc.scan.run.mutate();

    clock.set(localTime(20, 8, 59));
    await settled();
    expect(await scheduledScans(trpc)).toEqual([]);

    clock.set(localTime(20, 9, 0));
    await expect
      .poll(() => scheduledScans(trpc))
      .toEqual([expect.objectContaining({ result: "ok", time: localTime(20, 9).toISOString() })]);

    clock.set(localTime(20, 9, 1));
    clock.set(localTime(20, 18));
    clock.set(localTime(21, 8, 59));
    await settled();
    expect(await scheduledScans(trpc)).toHaveLength(1);

    clock.set(localTime(21, 9, 0));
    await expect.poll(async () => (await scheduledScans(trpc)).length).toBe(2);
  });

  test("a run missed while the app was closed runs on the next start, once", async () => {
    const { home, libraryHome } = await tempHome();
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    const first = await bootCore(env, { clock: fakeClock(localTime(20, 8)) });
    await connect(first).trpc.scan.run.mutate();
    await first.stop();

    const clock = fakeClock(localTime(23, 10));
    const second = await bootCore(env, { clock });
    const { trpc } = connect(second);

    await expect
      .poll(() => scheduledScans(trpc))
      .toEqual([expect.objectContaining({ time: localTime(23, 10).toISOString() })]);
    clock.set(localTime(23, 10, 1));
    clock.set(localTime(24, 8, 59));
    await settled();
    expect(await scheduledScans(trpc)).toHaveLength(1);
    // It stood in for the catch-up Scan on start: one Scan, not two.
    expect((await trpc.scan.status.query()).lastScanAt).not.toBeNull();
  });

  test("a run missed while the computer slept runs on wake, once", async () => {
    const { clock, trpc } = await setup(localTime(20, 8));
    await trpc.scan.run.mutate();

    clock.set(localTime(22, 14, 30));
    clock.set(localTime(22, 14, 31));

    await expect.poll(async () => (await scheduledScans(trpc)).length).toBe(1);
    await settled();
    expect(await scheduledScans(trpc)).toHaveLength(1);
  });

  test("doesn't run before the first Scan: the First run asks first", async () => {
    const { clock, trpc } = await setup(localTime(20, 8));

    clock.set(localTime(20, 9));
    clock.set(localTime(21, 9));
    await settled();

    expect(await scheduledScans(trpc)).toEqual([]);
    expect(await trpc.scan.status.query()).toEqual({ running: false, lastScanAt: null });
    expect(await trpc.scheduler.status.query()).toEqual({ time: "09:00", nextRunAt: null, lastRunAt: null });
  });

  test("runs at the time set in Settings and reports the next run", async () => {
    const { clock, trpc } = await setup(localTime(20, 6));
    await trpc.scan.run.mutate();
    expect(await trpc.scheduler.status.query()).toEqual({
      time: "09:00",
      nextRunAt: localTime(20, 9).toISOString(),
      lastRunAt: null,
    });

    await trpc.settings.updatePreferences.mutate({ scheduledScanTime: "07:30" });
    expect((await trpc.scheduler.status.query()).nextRunAt).toBe(localTime(20, 7, 30).toISOString());

    clock.set(localTime(20, 7, 30));
    await expect.poll(() => scheduledScans(trpc)).toHaveLength(1);
    await expect
      .poll(() => trpc.scheduler.status.query())
      .toEqual({
        time: "07:30",
        nextRunAt: localTime(21, 7, 30).toISOString(),
        lastRunAt: localTime(20, 7, 30).toISOString(),
      });
  });

  test("notifies about new Global Skills, not ones already seen or ignored", async () => {
    const { clock, trpc, fixture, notifier } = await setup(localTime(20, 8));
    await fixture.skill(".agents/skills/known", { name: "known" });
    await fixture.skill(".agents/skills/left-alone", { name: "left-alone" });
    await trpc.scan.run.mutate();
    await trpc.inbox.ignore.mutate({ id: "global-skill:~/.agents/skills/left-alone" });

    clock.set(localTime(20, 9));
    await expect.poll(() => scheduledScans(trpc)).toHaveLength(1);
    expect(notifier.sent).toEqual([]);

    await fixture.skill(".claude/skills/pdf", { name: "pdf" });
    await fixture.skill(".agents/skills/docx", { name: "docx" });
    clock.set(localTime(21, 9));
    await expect
      .poll(() => notifier.sent)
      .toEqual([{ title: "2 new Global Skills found", body: "docx, pdf. Review them in the Inbox.", path: "/inbox" }]);
  });

  test("notifies about a Global Skill a watcher re-scan found first (story 23)", async () => {
    const { home, clock, trpc, fixture, notifier } = await setup(localTime(20, 8));
    await mkdir(join(home, ".agents/skills"), { recursive: true });
    await trpc.scan.run.mutate();
    clock.set(localTime(20, 9));
    await expect.poll(() => scheduledScans(trpc)).toHaveLength(1);

    // The Agent folders are watched, so the Scan cache has it long before the next run.
    await fixture.skill(".agents/skills/pdf", { name: "pdf" });
    await expect
      .poll(async () => (await trpc.inbox.list.query()).globalSkills.flatMap((group) => group.findings), {
        timeout: 5000,
      })
      .toHaveLength(1);
    clock.set(localTime(21, 9));

    await expect
      .poll(() => notifier.sent)
      .toEqual([{ title: "New Global Skill found", body: "pdf. Review it in the Inbox.", path: "/inbox" }]);
    // Notified once: the next run is quiet.
    clock.set(localTime(22, 9));
    await expect.poll(() => scheduledScans(trpc)).toHaveLength(3);
    expect(notifier.sent).toHaveLength(1);
  }, 15_000);

  test("notifies about a Global Skill the startup Scan found after a restart", async () => {
    const { home, libraryHome } = await tempHome();
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    const firstClock = fakeClock(localTime(20, 8));
    const first = await bootCore(env, { clock: firstClock });
    await connect(first).trpc.scan.run.mutate();
    firstClock.set(localTime(20, 9));
    await expect.poll(() => scheduledScans(connect(first).trpc)).toHaveLength(1);
    await first.stop();
    await agentHome(home).skill(".claude/skills/pdf", { name: "pdf" });

    const clock = fakeClock(localTime(21, 8));
    const notifier = fakeNotifier();
    const second = await bootCore(env, { clock, notifier });
    const { trpc } = connect(second);
    await expect
      .poll(async () => (await trpc.inbox.list.query()).globalSkills.flatMap((group) => group.findings), {
        timeout: 5000,
      })
      .toHaveLength(1);
    clock.set(localTime(21, 9));

    await expect
      .poll(() => notifier.sent)
      .toEqual([{ title: "New Global Skill found", body: "pdf. Review it in the Inbox.", path: "/inbox" }]);
  });

  test("notifies about new Global MCP Servers and drift too (story 26)", async () => {
    const { home, libraryHome } = await tempHome();
    const fixture = agentHome(libraryHome);
    await fixture.skill(join(libraryHome, "skills/local/pdf"), { description: "About pdf" });
    await writeFile(
      join(libraryHome, "library-lock.json"),
      JSON.stringify({
        version: 1,
        skills: { "local/pdf": { source: "local/pdf", sourceType: "local", computedHash: "0".repeat(64) } },
      }),
    );
    const clock = fakeClock(localTime(20, 8));
    const notifier = fakeNotifier();
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }, { clock, notifier });
    const { trpc } = connect(core);
    const app = await gitRepo(home, "code/app");
    await trpc.project.add.mutate({ path: app, agents: ["claude-code"] });
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });
    await trpc.scan.run.mutate();
    clock.set(localTime(20, 9));
    await expect.poll(() => scheduledScans(trpc)).toHaveLength(1);
    expect(notifier.sent).toEqual([]);

    await agentHome(home).file(
      ".cursor/mcp.json",
      JSON.stringify({ mcpServers: { github: { command: "npx", args: ["gh-mcp"] } } }),
    );
    await rm(join(app, ".claude/skills/pdf"));
    clock.set(localTime(21, 9));

    await expect
      .poll(() => notifier.sent)
      .toEqual([
        {
          title: "2 new Inbox findings",
          body: "Global MCP Server: github; drift: app › pdf. Review them in the Inbox.",
          path: "/inbox",
        },
      ]);
  });

  test("never Adopts: it writes nothing outside state/, the Activity Log and what it has notified", async () => {
    const { clock, trpc, fixture, home } = await setup(localTime(20, 8));
    await trpc.scan.run.mutate();
    await fixture.skill(".agents/skills/pdf", { name: "pdf" });
    await fixture.link(".claude/skills/pdf", ".agents/skills/pdf");
    await fixture.skill("code/my-skills/mine", { name: "mine" });
    await fixture.link(".cursor/skills/mine", "code/my-skills/mine");
    const except = [".dark-matter/state", ".dark-matter/activity", ".dark-matter/settings.json"];
    const before = await snapshotTree(home, except);

    clock.set(localTime(20, 9));
    await expect.poll(() => scheduledScans(trpc)).toHaveLength(1);

    expect(await snapshotTree(home, except)).toEqual(before);
    expect(JSON.parse(await readFile(join(home, ".dark-matter/settings.json"), "utf8"))).toMatchObject({
      notifiedFindings: ["global-skill:~/.agents/skills/pdf", "global-skill:~/code/my-skills/mine"],
    });
    expect((await trpc.inbox.list.query()).count).toBe(2);
  });
});

describe("notifications", () => {
  test("reach the app over the notifications subscription when no notifier is injected", async () => {
    const { home, libraryHome } = await tempHome();
    const clock = fakeClock(localTime(20, 8));
    const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }, { clock });
    const { trpc } = connect(core);
    await trpc.scan.run.mutate();
    const received: unknown[] = [];
    let started = false;
    trpc.notifications.subscribe(undefined, {
      onStarted: () => (started = true),
      onData: (notification) => received.push(notification),
    });
    await expect.poll(() => started).toBe(true);
    await agentHome(home).skill(".claude/skills/pdf", { name: "pdf" });

    clock.set(localTime(20, 9));

    await expect
      .poll(() => received)
      .toEqual([{ title: "New Global Skill found", body: "pdf. Review it in the Inbox.", path: "/inbox" }]);
  });
});
