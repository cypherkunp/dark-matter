import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentHistory, agentHome, gitRepo, snapshotTree } from "./agent-home";
import { bootCore, connect, fakeClock, localTime, tempHome } from "./harness";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });

describe("First run", () => {
  test("nothing on the computer is read or written before you agree to the Scan", async () => {
    const { home, libraryHome } = await tempHome();
    const fixture = agentHome(home);
    await fixture.skill(".claude/skills/pdf", { name: "pdf", description: "PDFs" });
    const app = await gitRepo(home, "code/app");
    await agentHistory(home).claudeJson([app]);
    const before = await snapshotTree(home, [".dark-matter"]);

    const { trpc } = connect(await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }));

    expect((await trpc.settings.get.query()).firstRun).toBeUndefined();
    expect((await trpc.scan.status.query()).lastScanAt).toBeNull();
    expect((await trpc.inbox.list.query()).count).toBe(0);
    expect((await trpc.project.suggested.query()).suggested).toEqual([]);
    expect(await trpc.project.suggestedSkills.query()).toEqual([]);
    expect(await snapshotTree(home, [".dark-matter"])).toEqual(before);
  });

  test("completing it is stored in settings.json, so it runs once", async () => {
    const { home, libraryHome } = await tempHome();
    const clock = fakeClock(localTime(21, 10));
    const env = { HOME: home, DARK_MATTER_HOME: libraryHome };
    const first = await bootCore(env, { clock });
    const { trpc } = connect(first);

    await trpc.settings.completeFirstRun.mutate();

    const completedAt = localTime(21, 10).toISOString();
    expect(JSON.parse(await readFile(join(libraryHome, "settings.json"), "utf8"))).toMatchObject({
      firstRun: { completedAt },
    });
    const [entry] = (await trpc.activity.list.query({})).entries;
    expect(entry).toMatchObject({
      action: "settings.completeFirstRun",
      result: "ok",
      filesWritten: ["~/.dark-matter/settings.json"],
    });

    // Finishing again (a second window, say) keeps the first time.
    clock.set(localTime(21, 11));
    await trpc.settings.completeFirstRun.mutate();
    await first.stop();

    const again = connect(await bootCore(env)).trpc;
    expect((await again.settings.get.query()).firstRun).toEqual({ completedAt });
  });

  test("lists the Skills already in Suggested Projects before any is confirmed: untracked and Vendored", async () => {
    const { home, libraryHome } = await tempHome();
    const fixture = agentHome(home);
    const app = await gitRepo(home, "code/app");
    await agentHistory(home).claudeJson([app]);
    await fixture.skill(join(app, ".claude/skills/team"), { name: "team", description: "Team rules" });
    git(app, "add", ".claude/skills/team");
    git(app, "commit", "--quiet", "-m", "vendor team");
    await fixture.skill(join(app, ".agents/skills/notes"), { name: "notes", description: "Notes" });
    // Its Source is in the Project's skills-lock.json, as Adopt reads it (review #18).
    await writeFile(
      join(app, "skills-lock.json"),
      JSON.stringify({ version: 1, skills: { notes: { source: "acme/skills", sourceType: "github" } } }),
    );
    const { trpc } = connect(await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }));

    await trpc.scan.run.mutate();

    expect(await trpc.project.suggestedSkills.query()).toEqual([
      {
        path: app,
        name: "app",
        skills: [
          expect.objectContaining({
            name: "notes",
            folder: ".agents/skills",
            tracked: false,
            namespace: "acme/skills",
          }),
          expect.objectContaining({ name: "team", folder: ".claude/skills", tracked: true, namespace: "local" }),
        ],
      },
    ]);
    // Reading them confirms nothing: the Project stays Suggested and the Inbox doesn't list them yet.
    expect(await trpc.project.list.query()).toEqual([]);
    expect((await trpc.inbox.list.query()).untrackedSkills).toEqual([]);
  });
});
