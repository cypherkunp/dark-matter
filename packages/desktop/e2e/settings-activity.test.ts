import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

test("saves a preference from Settings and shows it in the Activity timeline", async ({ launchApp, fixtureHome }) => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByTestId("library-empty")).toBeVisible();

  await window.getByRole("link", { name: "Settings" }).click();
  await expect(window.getByRole("heading", { name: "Settings" })).toBeVisible();
  await window.getByLabel("Scheduled Scan time").fill("07:30");
  await window.getByRole("button", { name: "Save" }).click();

  await expect
    .poll(() => readFile(join(fixtureHome.libraryHome, "settings.json"), "utf8").then(JSON.parse, () => null))
    .toMatchObject({ preferences: { scheduledScanTime: "07:30" } });
  await expect(window.getByRole("button", { name: "Save" })).toBeDisabled();

  await window.getByTestId("sidebar").getByRole("link", { name: "Activity" }).click();
  await expect(window.getByRole("heading", { name: "Activity" })).toBeVisible();
  const today = window.getByTestId("activity-day").first();
  await expect(today.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(today.getByTestId("activity-entry").first()).toContainText("Saved preferences");
  await expect(today.getByTestId("activity-entry").first()).toContainText("app");
});

test("shows an invalid hand edit to settings.json and discards it", async ({ launchApp, fixtureHome }) => {
  const path = join(fixtureHome.libraryHome, "settings.json");
  const app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.getByTestId("library-empty")).toBeVisible();
  await window.getByRole("link", { name: "Settings" }).click();

  await writeFile(path, '{ "preferences": { "scheduledScanTime": "noon" } }');

  const alert = window.getByTestId("owned-file-problem");
  await expect(alert).toContainText("settings.json");
  await expect(alert).toContainText("scheduledScanTime");
  await expect(window.getByRole("button", { name: "Save" })).toBeDisabled();

  await alert.getByRole("button", { name: "Discard my edit" }).click();

  await expect(alert).toBeHidden();
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ preferences: { scheduledScanTime: "09:00" } });
});
