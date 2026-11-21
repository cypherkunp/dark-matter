import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { memorySecrets } from "../src/index";
import { agentHome } from "./agent-home";
import { fakeGitHub, skillMd } from "./fake-github";
import { bootCore, connect, tempHome } from "./harness";

const setup = async (
  options: { ghToken?: string; pat?: string; library?: Record<string, Record<string, string>> } = {},
) => {
  const { home, libraryHome } = await tempHome();
  if (options.library) {
    // Library Skills that were there before the core started.
    for (const [key, entry] of Object.entries(options.library)) {
      await agentHome(libraryHome).skill(join(libraryHome, "skills", key), { description: key });
      options.library[key] = { computedHash: "0".repeat(64), ...entry };
    }
    await writeFile(join(libraryHome, "library-lock.json"), JSON.stringify({ version: 1, skills: options.library }));
  }
  const github = await fakeGitHub();
  const secrets = memorySecrets();
  if (options.pat) secrets.values.set("github-pat", options.pat);
  const core = await bootCore(
    { HOME: home, DARK_MATTER_HOME: libraryHome },
    { secrets, github: { api: github.api, ghToken: async () => options.ghToken ?? null } },
  );
  const { trpc } = connect(core);
  /** Previews then Imports the given repo paths, as the picker does. */
  const importPaths = async (input: string, paths: string[]) => {
    const preview = await trpc.importer.preview.query({ input });
    return trpc.importer.import.mutate({ input, commit: preview.commit, paths });
  };
  const lock = async () => JSON.parse(await readFile(join(libraryHome, "library-lock.json"), "utf8"));
  return { home, libraryHome, github, secrets, trpc, importPaths, lock };
};

const acmeSkills = {
  "skills/pdf/SKILL.md": skillMd("pdf", "Work with PDFs", "Use pdftotext.\n"),
  "skills/pdf/scripts/extract.py": "print('pdf')\n",
  "skills/xlsx/SKILL.md": skillMd("xlsx", "Work with spreadsheets"),
};

describe("GitHub Import", () => {
  test("previewing owner/repo lists every Skill found the way `npx skills add` finds them, none ticked", async () => {
    const { github, trpc } = await setup();
    const repo = await github.repo("acme/skills", {
      "README.md": "# Acme skills\n",
      "skills/pdf/SKILL.md": skillMd("pdf", "Work with PDFs", "Use pdftotext.\n"),
      "skills/xlsx/SKILL.md": skillMd("xlsx", "Work with spreadsheets"),
      ".claude/skills/review/SKILL.md": skillMd("review", "Review a diff"),
    });

    const preview = await trpc.importer.preview.query({ input: "acme/skills" });

    expect(preview).toMatchObject({ source: "acme/skills", ref: "main", commit: repo.head(), subpath: null });
    expect(
      preview.skills.map(({ name, path, selected, key, inLibrary }) => ({ name, path, selected, key, inLibrary })),
    ).toEqual([
      { name: "pdf", path: "skills/pdf", selected: false, key: "acme/skills/pdf", inLibrary: false },
      { name: "xlsx", path: "skills/xlsx", selected: false, key: "acme/skills/xlsx", inLibrary: false },
      { name: "review", path: ".claude/skills/review", selected: false, key: "acme/skills/review", inLibrary: false },
    ]);
    expect(preview.skills[0]).toMatchObject({
      description: "Work with PDFs",
      skillMd: skillMd("pdf", "Work with PDFs", "Use pdftotext.\n"),
    });
  });

  test("a single-Skill repo comes pre-selected", async () => {
    const { github, trpc } = await setup();
    await github.repo("solo/writer", { "SKILL.md": skillMd("writer", "Write prose") });

    const preview = await trpc.importer.preview.query({ input: "https://github.com/solo/writer" });

    expect(preview.skills).toMatchObject([{ name: "writer", path: ".", selected: true, key: "solo/writer/writer" }]);
  });

  test("a tree URL limits the search to its path and tracks its branch", async () => {
    const { github, trpc } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    const beta = await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs, beta") }, "beta");

    const preview = await trpc.importer.preview.query({ input: "https://github.com/acme/skills/tree/beta/skills/pdf" });

    expect(preview).toMatchObject({ ref: "beta", commit: beta, subpath: "skills/pdf" });
    expect(preview.skills).toMatchObject([
      { name: "pdf", description: "PDFs, beta", path: "skills/pdf", selected: true },
    ]);
  });

  test("a skills.sh listing URL resolves to its repo and ticks the Skill it names", async () => {
    const { github, trpc } = await setup();
    await github.repo("acme/skills", acmeSkills);

    const preview = await trpc.importer.preview.query({ input: "https://skills.sh/acme/skills/xlsx" });

    expect(preview.source).toBe("acme/skills");
    expect(preview.skills.map(({ name, selected }) => ({ name, selected }))).toEqual([
      { name: "pdf", selected: false },
      { name: "xlsx", selected: true },
    ]);
  });

  test("Import puts the picked Skills in the Library, pinned to the commit and following the ref", async () => {
    const { github, trpc, importPaths, lock, libraryHome } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);

    const result = await importPaths("acme/skills", ["skills/pdf"]);

    expect(result).toEqual({
      source: "acme/skills",
      ref: "main",
      commit: repo.head(),
      skills: [{ key: "acme/skills/pdf", path: "skills/pdf", outcome: "imported" }],
    });
    const folder = join(libraryHome, "skills/acme/skills/pdf");
    expect(await readFile(join(folder, "scripts/extract.py"), "utf8")).toBe("print('pdf')\n");
    const treeSha = execFileSync("git", ["rev-parse", "HEAD:skills/pdf"], { cwd: repo.dir, encoding: "utf8" }).trim();
    expect((await lock()).skills).toEqual({
      "acme/skills/pdf": {
        source: "acme/skills",
        sourceType: "github",
        ref: "main",
        commit: repo.head(),
        skillPath: "skills/pdf/SKILL.md",
        computedHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        skillFolderHash: treeSha,
      },
    });
    const { skills } = await trpc.library.list.query();
    expect(skills).toMatchObject([{ key: "acme/skills/pdf", namespace: "acme/skills", modified: false }]);
    expect(await readdir(join(libraryHome, "staging"))).toEqual([]);
    const { entries } = await trpc.activity.list.query({});
    expect(entries[0]).toMatchObject({
      action: "importer.import",
      result: "ok",
      subjects: [
        { kind: "source", id: "acme/skills" },
        { kind: "skill", id: "acme/skills/pdf" },
      ],
    });
  });

  test("re-importing the same Source and path checks for an update and never duplicates", async () => {
    const { github, importPaths, lock } = await setup();
    const repo = await github.repo("acme/skills", acmeSkills);
    await importPaths("acme/skills", ["skills/pdf"]);
    const before = await lock();

    expect((await importPaths("acme/skills", ["skills/pdf"])).skills).toEqual([
      { key: "acme/skills/pdf", path: "skills/pdf", outcome: "upToDate" },
    ]);

    // A commit elsewhere in the repo isn't an update to pdf.
    await repo.commit({ "skills/xlsx/SKILL.md": skillMd("xlsx", "Spreadsheets v2") });
    expect((await importPaths("acme/skills", ["skills/pdf"])).skills[0]?.outcome).toBe("upToDate");

    await repo.commit({ "skills/pdf/SKILL.md": skillMd("pdf", "PDFs v2") });
    expect((await importPaths("acme/skills", ["skills/pdf", "skills/xlsx"])).skills).toEqual([
      { key: "acme/skills/pdf", path: "skills/pdf", outcome: "updateAvailable" },
      { key: "acme/skills/xlsx", path: "skills/xlsx", outcome: "imported" },
    ]);
    const after = await lock();
    expect(after.skills["acme/skills/pdf"]).toEqual(before.skills["acme/skills/pdf"]);
    expect(Object.keys(after.skills)).toEqual(["acme/skills/pdf", "acme/skills/xlsx"]);
  });

  test("a Skill whose key another Skill holds lands beside it, under the same Namespace", async () => {
    const { github, importPaths, lock } = await setup({
      library: { "acme/skills/pdf": { source: "acme/skills", sourceType: "github", skillPath: "pdf/SKILL.md" } },
    });
    await github.repo("acme/skills", { "skills/pdf/SKILL.md": skillMd("pdf", "Work with PDFs") });

    const result = await importPaths("acme/skills", ["skills/pdf"]);

    const key = result.skills[0]?.key ?? "";
    expect(key).toMatch(/^acme\/skills\/pdf-[0-9a-f]{7}$/);
    expect(Object.keys((await lock()).skills).sort()).toEqual(["acme/skills/pdf", key]);
  });

  test("Auth uses the gh login token, else the keychain PAT, else goes anonymous", async () => {
    const gh = await setup({ ghToken: "gho_cli", pat: "ghp_saved" });
    await gh.github.repo("acme/private", { "SKILL.md": skillMd("secret", "Shh") }, { private: true });
    gh.github.tokens.add("gho_cli");
    expect(await gh.trpc.importer.auth.query()).toEqual({ method: "gh", pat: true });
    expect((await gh.trpc.importer.preview.query({ input: "acme/private" })).auth).toBe("gh");
    expect(gh.github.requests.every((request) => request.authorization === "Bearer gho_cli")).toBe(true);

    const pat = await setup({ pat: "ghp_saved" });
    await pat.github.repo("acme/private", { "SKILL.md": skillMd("secret", "Shh") }, { private: true });
    pat.github.tokens.add("ghp_saved");
    expect((await pat.trpc.importer.preview.query({ input: "acme/private" })).auth).toBe("pat");

    const anonymous = await setup();
    await anonymous.github.repo("acme/private", { "SKILL.md": skillMd("secret", "Shh") }, { private: true });
    expect(await anonymous.trpc.importer.auth.query()).toEqual({ method: "anonymous", pat: false });
    await expect(anonymous.trpc.importer.preview.query({ input: "acme/private" })).rejects.toMatchObject({
      data: { tag: "SourceUnreachable" },
    });
    expect(anonymous.github.requests.every((request) => request.authorization === null)).toBe(true);
  });

  test("a PAT entered in Settings goes into the keychain and is used for private repos", async () => {
    const { github, secrets, trpc } = await setup();
    await github.repo("acme/private", { "SKILL.md": skillMd("secret", "Shh") }, { private: true });
    github.tokens.add("ghp_new");

    expect(await trpc.importer.setToken.mutate({ token: "ghp_new" })).toEqual({ method: "pat", pat: true });
    expect(secrets.values.get("github-pat")).toBe("ghp_new");
    expect((await trpc.importer.preview.query({ input: "acme/private" })).skills).toHaveLength(1);
    const { entries } = await trpc.activity.list.query({});
    expect(JSON.stringify(entries)).not.toContain("ghp_new");

    expect(await trpc.importer.setToken.mutate({ token: null })).toEqual({ method: "anonymous", pat: false });
    expect(secrets.values.has("github-pat")).toBe(false);
  });

  test("a used-up rate limit and input that isn't a GitHub Source fail with tagged errors", async () => {
    const { github, trpc } = await setup();
    await github.repo("acme/skills", acmeSkills);
    await expect(trpc.importer.preview.query({ input: "not a repo" })).rejects.toMatchObject({
      data: { tag: "InvalidImportSource" },
    });
    await expect(trpc.importer.preview.query({ input: "https://gitlab.com/acme/skills" })).rejects.toMatchObject({
      data: { tag: "InvalidImportSource" },
    });
    github.rateLimited = true;
    await expect(trpc.importer.preview.query({ input: "acme/skills" })).rejects.toMatchObject({
      data: { tag: "RateLimited" },
    });
  });
});
