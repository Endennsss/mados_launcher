import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { LauncherApi, WorkerEvent } from "../contracts/launcher";

const api: LauncherApi = {
  invoke<T = unknown>(method: string, params?: unknown): Promise<T> {
    return ipcRenderer.invoke("worker-invoke", method, params) as Promise<T>;
  },
  onEvent(listener: (event: WorkerEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: WorkerEvent) => listener(value);
    ipcRenderer.on("worker-event", handler);
    return () => ipcRenderer.removeListener("worker-event", handler);
  },
  minimize: () => ipcRenderer.send("window-minimize"),
  toggleMaximize: () => ipcRenderer.send("window-toggle-maximize"),
  close: () => ipcRenderer.send("window-close"),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  pickContentBundle: () => ipcRenderer.invoke("pick-content-bundle") as Promise<string | null>,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.send("install-update"),
};

// Window state and fatal process errors are delivered as DOM events so the
// renderer gets a narrow, typed surface without exposing ipcRenderer itself.
ipcRenderer.on("window-state", (_event, value: { maximized: boolean }) => {
  window.dispatchEvent(new CustomEvent("window-state", { detail: value }));
});
ipcRenderer.on("launcher-error", (_event, value: { message: string }) => {
  window.dispatchEvent(new CustomEvent("launcher-error", { detail: value }));
});

contextBridge.exposeInMainWorld("mados", api);
