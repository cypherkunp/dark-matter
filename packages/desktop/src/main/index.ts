import { join, resolve } from "node:path";
import { corePaths, resolveLibraryHome } from "@dark-matter/contracts/paths";
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { CoreSupervisor } from "./core-supervisor";

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
};

ipcMain.handle("core:connection", () => supervisor.connection());

app.whenReady().then(() => {
  supervisor.start();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void supervisor.stop().finally(() => app.quit());
});
