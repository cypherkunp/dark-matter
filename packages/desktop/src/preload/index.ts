import { contextBridge, ipcRenderer } from "electron";
import type { DarkMatterBridge } from "../shared/bridge";

const bridge: DarkMatterBridge = {
  platform: process.platform,
  coreConnection: () => ipcRenderer.invoke("core:connection"),
  chooseFolder: (title) => ipcRenderer.invoke("dialog:chooseFolder", title),
  openFolder: (path) => ipcRenderer.invoke("shell:openFolder", path),
};

contextBridge.exposeInMainWorld("darkMatter", bridge);
