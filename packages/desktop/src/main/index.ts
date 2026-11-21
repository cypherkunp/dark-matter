import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { corePaths, resolveLibraryHome } from "@dark-matter/contracts/paths";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { CoreSupervisor } from "./core-supervisor";
import { startResidency } from "./residency";

const log = (message: string) => process.stderr.write(`[dark-matter main] ${message}\n`);

/** The bundled core: an extra resource when packaged, the core package's build in development. */
const coreEntry = () =>
  app.isPackaged
    ? join(process.resourcesPath, "core", "main.mjs")
    : (process.env.DARK_MATTER_CORE_ENTRY ?? resolve(app.getAppPath(), "../core/dist/main.mjs"));

const supervisor = new CoreSupervisor({
  coreFilePath: corePaths(resolveLibraryHome(process.env)).coreFile,
  coreEntry: coreEntry(),
  env: process.env,
  log,
});

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "Dark Matter",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    // Resident in the menu bar (ADR-0003): no window, no Dock icon, still running.
    if (process.platform === "darwin") app.dock?.hide();
  });
  window.once("ready-to-show", () => window.show());
  // Links leave the app for the browser; the window never navigates away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServer) void window.loadURL(devServer);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return window;
};

/** Brings the window back (from the tray or a notification), optionally on `path`. */
const showWindow = (path?: string) => {
  if (process.platform === "darwin") void app.dock?.show();
  const window = mainWindow ?? createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (!path) return;
  const navigate = () => window.webContents.send("app:navigate", path);
  if (window.webContents.isLoading()) window.webContents.once("did-finish-load", navigate);
  else navigate();
};

let residency: ReturnType<typeof startResidency> | undefined;

ipcMain.handle("core:connection", () => supervisor.connection());
ipcMain.handle("dialog:chooseFolder", async (event, title: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    properties: ["openDirectory"],
    ...(typeof title === "string" ? { title } : {}),
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.handle("shell:openFolder", async (_event, path: unknown) => {
  // Folders only: opening a file path would run it.
  if (typeof path === "string" && (await stat(path).catch(() => null))?.isDirectory()) await shell.openPath(path);
});

app.whenReady().then(() => {
  supervisor.start();
  residency = startResidency({ connection: () => supervisor.connection(), showWindow, log });
  // Started at login: stay in the menu bar until asked.
  if (!app.getLoginItemSettings().wasOpenedAtLogin) createWindow();
  else if (process.platform === "darwin") app.dock?.hide();
  app.on("activate", () => showWindow());
});

// Closing the window keeps the app (and the Scheduled Scan) running; Quit is in the tray menu.
app.on("window-all-closed", () => {});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void Promise.allSettled([residency?.stop(), supervisor.stop()]).finally(() => app.quit());
});
