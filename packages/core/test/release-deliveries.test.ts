// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${secret:…}` is an MCP reference, not a template.
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "@dark-matter/contracts";
import { describe, expect, test } from "vitest";
import { memorySecrets } from "../src/index";
import { agentHome, gitRepo } from "./agent-home";
import { bootCore, connect, tempHome } from "./harness";

const github = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:github.TOKEN}" },
};
const linear = {
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  headers: { Authorization: "Bearer ${secret:linear.Authorization}" },
};

/** Library Skills and MCP Servers written before the core starts. */
const setup = async (keys: string[] = ["local/pdf", "local/docx"]) => {
  const { home, libraryHome } = await tempHome();
  const fixture = agentHome(libraryHome);
  const entries: Record<string, unknown> = {};
  for (const key of keys) {
    await fixture.skill(join(libraryHome, "skills", key), { description: `About ${key}` });
    entries[key] = { source: key, sourceType: "local", computedHash: "0".repeat(64) };
  }
  await mkdir(join(libraryHome, "mcp"), { recursive: true });
  await writeFile(join(libraryHome, "library-lock.json"), JSON.stringify({ version: 1, skills: entries }));
  await writeFile(join(libraryHome, "mcp/github.json"), JSON.stringify(github));
  await writeFile(join(libraryHome, "mcp/linear.json"), JSON.stringify(linear));
  const secrets = memorySecrets(
    new Map([
      ["github.TOKEN", "ghp_real"],
      ["linear.Authorization", "lin_real"],
    ]),
  );
  const core = await bootCore({ HOME: home, DARK_MATTER_HOME: libraryHome }, { secrets });
  const { trpc } = connect(core);
  const project = async (dir: string, agents: AgentId[] = ["claude-code"]) => {
    const path = await gitRepo(home, dir);
    await trpc.project.add.mutate({ path, agents });
    return path;
  };
  return { home, libraryHome, trpc, project, fixture: agentHome(home) };
};

const entryAt = (path: string) =>
  lstat(path).then(
    async (info) => (info.isSymbolicLink() ? `link → ${await readlink(path)}` : info.isDirectory() ? "dir" : "file"),
    () => null,
  );
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("removing a Project", () => {
  test("shows a plan, then removes its Links and Personal MCP entries; Copies and Shared entries stay, as the plan says", async () => {
    const { home, libraryHome, trpc, project } = await setup();
    const app = await project("code/app");
    await trpc.project.addSkills.mutate({
      skills: [
        { path: app, key: "local/pdf" },
        { path: app, key: "local/docx", mode: "copy" },
      ],
    });
    await trpc.project.addMcpServers.mutate({
      servers: [
        { path: app, name: "github" },
        { path: app, name: "linear", mode: "shared" },
      ],
    });
    const sharedBefore = await readFile(join(app, ".mcp.json"), "utf8");

    expect(await trpc.project.removePlan.query({ path: app })).toEqual({
      path: app,
      links: [".claude/skills/pdf"],
      personalMcpServers: [{ name: "github", file: "~/.claude.json" }],
      keptCopies: [".agents/skills/docx"],
      keptSharedMcpServers: [{ name: "linear", file: "~/code/app/.mcp.json" }],
    });

    await trpc.project.remove.mutate({ path: app });

    expect(await entryAt(join(app, ".claude/skills/pdf"))).toBeNull();
    expect(await readFile(join(app, ".git/info/exclude"), "utf8")).not.toContain("pdf");
    expect((await readJson(join(home, ".claude.json"))).projects?.[app]?.mcpServers?.github).toBeUndefined();
    expect(await entryAt(join(app, ".agents/skills/docx"))).toBe("dir");
    expect(await readFile(join(app, ".mcp.json"), "utf8")).toBe(sharedBefore);
    expect((await readJson(join(libraryHome, "projects.json"))).projects).toEqual({});
  });
});

describe("deleting a Library Skill", () => {
  test("removes its Links and Project records everywhere; a Copy stays as committed files", async () => {
    const { libraryHome, trpc, project } = await setup();
    const app = await project("code/app");
    const api = await project("code/api", ["codex"]);
    const web = await project("code/web");
    await trpc.project.addSkills.mutate({
      skills: [
        { path: app, key: "local/pdf" },
        { path: api, key: "local/pdf" },
        { path: web, key: "local/pdf", mode: "copy" },
        { path: app, key: "local/docx" },
      ],
    });

    expect((await trpc.skill.deletePlan.query({ key: "local/pdf" })).projects.map((use) => use.mode).sort()).toEqual([
      "copy",
      "link",
      "link",
    ]);
    await trpc.skill.delete.mutate({ key: "local/pdf" });

    expect(await entryAt(join(app, ".claude/skills/pdf"))).toBeNull();
    expect(await entryAt(join(api, ".agents/skills/pdf"))).toBeNull();
    expect(await entryAt(join(app, ".claude/skills/docx"))).toBe(`link → ${join(libraryHome, "skills/local/docx")}`);
    expect(await entryAt(join(web, ".agents/skills/pdf"))).toBe("dir");
    const records = (await readJson(join(libraryHome, "projects.json"))).projects;
    for (const path of [app, api, web]) expect(Object.keys(records[path].skills)).not.toContain("local/pdf");
    expect((await trpc.project.skills.query({ path: app })).map((skill) => skill.key)).toEqual(["local/docx"]);
  });
});

describe("Undo Adopt", () => {
  test("removes every Link to the Skill, including ones added after the Adopt, before moving it back", async () => {
    const { home, libraryHome, trpc, project, fixture } = await setup([]);
    await fixture.skill(".claude/skills/pdf", { name: "pdf" });
    await trpc.scan.run.mutate();
    const plan = await trpc.adopt.plan.query({ findings: ["global-skill:~/.claude/skills/pdf"] });
    await trpc.adopt.execute.mutate({ findings: plan.findings, planId: plan.planId });
    const app = await project("code/app");
    await trpc.project.addSkills.mutate({ skills: [{ path: app, key: "local/pdf" }] });

    expect((await trpc.adopt.undoPlan.query({ key: "local/pdf" })).projects).toEqual([
      { path: app, projectName: "app", mode: "link", on: true },
    ]);
    await trpc.adopt.undo.mutate({ key: "local/pdf" });

    expect(await entryAt(join(app, ".claude/skills/pdf"))).toBeNull();
    expect(await entryAt(join(home, ".claude/skills/pdf"))).toBe("dir");
    expect((await readJson(join(libraryHome, "projects.json"))).projects[app].skills).toEqual({});
  });
});
