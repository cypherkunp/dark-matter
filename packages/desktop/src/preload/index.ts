import { contextBridge, ipcRenderer } from "electron";
import type { DarkMatterBridge } from "../shared/bridge";

const bridge: DarkMatterBridge = {
  platform: process.platform,
  coreConnection: () => ipcRenderer.invoke("core:connection"),
};

contextBridge.exposeInMainWorld("darkMatter", bridge);
