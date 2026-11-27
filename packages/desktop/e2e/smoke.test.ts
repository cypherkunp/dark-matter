import { expect, isAlive, test } from "./fixtures";

test("launches, starts a core and shows the empty Library", async ({ launchApp, fixtureHome }) => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await expect(window.getByTestId("library-empty")).toBeVisible();
  await expect(window.getByRole("heading", { name: "All Skills" })).toBeVisible();
  await expect(window.getByTestId("core-status")).toHaveText("Not scanned yet");
  for (const section of ["Inbox", "All Skills", "Favourites", "Collections", "skills.sh", "Agents", "Activity"]) {
    await expect(window.getByTestId("sidebar").getByText(section, { exact: true })).toBeVisible();
  }

  const coreFile = await fixtureHome.readCoreFile();
  const mainPid = await app.evaluate(() => process.pid);
  expect(coreFile?.pid).not.toBe(mainPid);

  await app.close();
  // The app started this core, so quitting stops it and removes core.json.
  await expect.poll(() => fixtureHome.readCoreFile()).toBeNull();
  expect(isAlive(coreFile?.pid ?? 0)).toBe(false);
});

test("renders the shell in light and dark mode", async ({ launchApp }) => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByTestId("library-empty")).toBeVisible();

  const colours = () =>
    window.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      content: getComputedStyle(document.querySelector('[data-testid="content-panel"]') as Element).backgroundColor,
      sidebar: getComputedStyle(document.querySelector('[data-testid="sidebar"]') as Element).backgroundColor,
    }));

  await window.emulateMedia({ colorScheme: "light" });
  await expect.poll(async () => (await colours()).dark).toBe(false);
  const light = await colours();
  // The content panel floats on the dark chrome the sidebar sits on.
  expect(light.sidebar).not.toBe(light.content);

  await window.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => (await colours()).dark).toBe(true);
  const dark = await colours();
  expect(dark.content).not.toBe(light.content);
  // The chrome is near-black in both themes.
  expect(dark.sidebar).toBe(light.sidebar);
  expect(dark.content).not.toBe(dark.sidebar);
});

test("attaches to a core that is already running instead of starting another", async ({
  launchApp,
  startHeadlessCore,
  fixtureHome,
}) => {
  const headless = await startHeadlessCore();

  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByTestId("library-empty")).toBeVisible();
  expect((await fixtureHome.readCoreFile())?.pid).toBe(headless.pid);

  await app.close();
  // The app didn't start this core, so it leaves it running.
  expect(isAlive(headless.pid ?? 0)).toBe(true);
  expect((await fixtureHome.readCoreFile())?.pid).toBe(headless.pid);
});

test("restarts a crashed core and reconnects", async ({ launchApp, fixtureHome }) => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByTestId("core-status")).toHaveText("Not scanned yet");
  const first = await fixtureHome.readCoreFile();
  if (!first) throw new Error("no core.json after launch");

  process.kill(first.pid, "SIGKILL");

  await expect.poll(async () => (await fixtureHome.readCoreFile())?.pid).not.toBe(first.pid);
  const second = await fixtureHome.readCoreFile();
  expect(second && isAlive(second.pid)).toBe(true);
  expect(second?.token).not.toBe(first.token);
  await expect(window.getByTestId("core-status")).toHaveText("Not scanned yet");
  await expect(window.getByTestId("library-empty")).toBeVisible();
});
