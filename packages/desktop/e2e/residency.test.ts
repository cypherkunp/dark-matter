import { expect, isAlive, test } from "./fixtures";

test("closing the window keeps the app and the core running in the menu bar", async ({ launchApp, fixtureHome }) => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await window.getByRole("button", { name: "Scan now" }).click();
  // The footer shows the next Scheduled Scan once a Scan has run.
  await expect(window.getByTestId("core-status")).toContainText(/Scanned .* · next 09:00/);
  const core = await fixtureHome.readCoreFile();

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());

  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  expect(isAlive(core?.pid ?? 0)).toBe(true);
  expect((await fixtureHome.readCoreFile())?.pid).toBe(core?.pid);

  // Opening it again (Dock click or the tray menu) brings back the same core's data.
  const reopened = app.waitForEvent("window");
  await app.evaluate(({ app }) => app.emit("activate"));
  await expect((await reopened).getByTestId("core-status")).toContainText("· next 09:00");
});
