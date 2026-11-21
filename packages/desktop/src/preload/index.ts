import { contextBridge, ipcRenderer } from "electron";
import type { DarkMatterBridge } from "../shared/bridge";

const bridge: DarkMatterBridge = {
  platform: process.platform,
  coreConnection: () => ipcRenderer.invoke("core:connection"),
  onNavigate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, path: string) => listener(path);
    ipcRenderer.on("app:navigate", handler);
    return () => ipcRenderer.off("app:navigate", handler);
  },
  chooseFolder: (title) => ipcRenderer.invoke("dialog:chooseFolder", title),
  openFolder: (path) => ipcRenderer.invoke("shell:openFolder", path),
};

contextBridge.exposeInMainWorld("darkMatter", bridge);
