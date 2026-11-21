import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

const readOrNull = (path: string) => readFile(path, "utf8").catch(() => null);

test("⌘K adds a Collection with a Skill and an MCP Server to a Project: a Link and a Personal Project MCP Server", async ({
  launchApp,
  fixtureHome,
}) => {
  const { home, libraryHome } = fixtureHome;
  const folder = join(libraryHome, "skills/local/pdf");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"), '---\nname: "pdf"\ndescription: "Work with PDFs"\n---\n');
  await writeFile(
    join(libraryHome, "library-lock.json"),
    JSON.stringify({
      version: 1,
      skills: { "local/pdf": { source: "local", sourceType: "local", computedHash: "0" } },
    }),
  );
  await mkdir(join(libraryHome, "mcp"), { recursive: true });
  await writeFile(
    join(libraryHome, "mcp/linear.json"),
    JSON.stringify({ transport: "http", url: "https://mcp.linear.app/mcp" }),
  );
  await writeFile(
    join(libraryHome, "settings.json"),
    JSON.stringify({
      firstRun: { completedAt: "2026-11-01T00:00:00.000Z" },
      collections: {
        kit: {
          items: [
            { kind: "skill", key: "local/pdf" },
            { kind: "mcpServer", name: "linear" },
          ],
        },
      },
    }),
  );
  const app = join(home, "code", "app");
  await mkdir(app, { recursive: true });
  execFileSync("git", ["init", "--quiet", app]);
  await writeFile(join(libraryHome, "projects.json"), JSON.stringify({ projects: { [app]: { agents: ["cursor"] } } }));

  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();
  await expect(window.getByTestId("sidebar-collection")).toContainText("kit");

  await window.keyboard.press("ControlOrMeta+k");
  const palette = window.getByTestId("command-palette");
  await palette.getByRole("combobox").fill("add kit to projects");
  await palette.getByRole("combobox").press("Enter");

  const grid = window.getByTestId("add-to-projects-grid");
  await expect(window.getByTestId("collection-server")).toContainText("linear");
  await expect(grid.getByRole("radiogroup", { name: "Deliver linear as" })).toContainText("Personal");
  await grid.getByRole("button", { name: "app" }).click();
  await window.getByRole("button", { name: "Add 1 Skill and 1 MCP Server" }).click();

  await expect.poll(() => readOrNull(join(app, ".cursor/mcp.json"))).toContain("https://mcp.linear.app/mcp");
  await expect
    .poll(() =>
      lstat(join(app, ".agents/skills/pdf")).then(
        (info) => info.isSymbolicLink(),
        () => null,
      ),
    )
    .toBe(true);
});
