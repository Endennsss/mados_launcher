import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { CdnImportRequest, CdnInspection, DiscordPresenceStatus, FavoriteMonitorSummary, LauncherApi, LauncherNotification, LaunchProfile, LocalServerBackup, LocalServerConfig, LocalServerCreateInput, LocalServerProfile, LocalServerSnapshot, LocalServerUpdateInput, PortTestResult, ServerNote, StartupState, WorkerEvent } from "../contracts/launcher";

const api: LauncherApi = {
  invoke<T = unknown>(method: string, params?: unknown): Promise<T> {
    return ipcRenderer.invoke("worker-invoke", method, params) as Promise<T>;
  },
  serverNotes: {
    list: () => ipcRenderer.invoke("worker-invoke", "serverNotes.list", {}) as Promise<ServerNote[]>,
    upsert: (address: string, text: string) => ipcRenderer.invoke("worker-invoke", "serverNotes.upsert", { address, text }) as Promise<ServerNote | null>,
    remove: (address: string) => ipcRenderer.invoke("worker-invoke", "serverNotes.remove", { address }) as Promise<{ removed: boolean }>,
  },
  monitoring: {
    getFavorites: () => ipcRenderer.invoke("worker-invoke", "monitoring.getFavorites", {}) as Promise<{ accountId: string; favorites: FavoriteMonitorSummary[] }>,
    refresh: () => ipcRenderer.invoke("worker-invoke", "monitoring.refresh", {}) as Promise<{ accountId: string; favorites: FavoriteMonitorSummary[] }>,
  },
  launchProfiles: {
    list: () => ipcRenderer.invoke("worker-invoke", "launchProfiles.list", {}) as Promise<LaunchProfile[]>,
    create: (name: string, address: string) => ipcRenderer.invoke("worker-invoke", "launchProfiles.create", { name, address }) as Promise<LaunchProfile>,
    update: (id: string, name: string, address: string) => ipcRenderer.invoke("worker-invoke", "launchProfiles.update", { id, name, address }) as Promise<LaunchProfile>,
    remove: (id: string) => ipcRenderer.invoke("worker-invoke", "launchProfiles.remove", { id }) as Promise<{ removed: boolean }>,
    use: (id: string) => ipcRenderer.invoke("worker-invoke", "launchProfiles.use", { id }) as Promise<LaunchProfile>,
  },
  notifications: {
    list: () => ipcRenderer.invoke("worker-invoke", "notifications.list", {}) as Promise<LauncherNotification[]>,
    markRead: (id: string) => ipcRenderer.invoke("worker-invoke", "notifications.markRead", { id }) as Promise<{ marked: boolean }>,
    clear: () => ipcRenderer.invoke("worker-invoke", "notifications.clear", {}) as Promise<{ removed: number }>,
  },
  tools: {
    cdnInspect: (sourceUrl: string) => ipcRenderer.invoke("worker-invoke", "tools.cdn.inspect", { sourceUrl }) as Promise<CdnInspection>,
    cdnImport: (request: CdnImportRequest) => ipcRenderer.invoke("worker-invoke", "tools.cdn.import", request) as Promise<{ operationId: string; profile: LocalServerProfile }>,
    cdnCancel: (operationId: string) => ipcRenderer.invoke("worker-invoke", "tools.cdn.cancel", { operationId }) as Promise<{ cancelled: boolean }>,
  },
  localServers: {
    list: () => ipcRenderer.invoke("worker-invoke", "localServers.list", {}) as Promise<LocalServerProfile[]>,
    create: (input: LocalServerCreateInput) => ipcRenderer.invoke("worker-invoke", "localServers.create", input) as Promise<{ operationId: string; profile: LocalServerProfile }>,
    update: (id: string, input: LocalServerUpdateInput) => ipcRenderer.invoke("worker-invoke", "localServers.update", { id, ...input }) as Promise<LocalServerProfile>,
    remove: (id: string) => ipcRenderer.invoke("worker-invoke", "localServers.remove", { id }) as Promise<{ removed: boolean }>,
    start: (id: string) => ipcRenderer.invoke("worker-invoke", "localServers.start", { id }) as Promise<LocalServerSnapshot>,
    stop: (id: string) => ipcRenderer.invoke("worker-invoke", "localServers.stop", { id }) as Promise<LocalServerSnapshot>,
    restart: (id: string) => ipcRenderer.invoke("worker-invoke", "localServers.restart", { id }) as Promise<LocalServerSnapshot>,
    getStatus: (id?: string) => ipcRenderer.invoke("worker-invoke", "localServers.getStatus", id ? { id } : {}) as Promise<LocalServerSnapshot>,
    getConfig: (id: string) => ipcRenderer.invoke("worker-invoke", "localServers.getConfig", { id }) as Promise<LocalServerConfig>,
    saveConfig: (id: string, config: LocalServerConfig, mode: "fields" | "raw") => ipcRenderer.invoke("worker-invoke", "localServers.saveConfig", { id, config, mode }) as Promise<LocalServerConfig>,
    testPort: (port: number, bindAddress?: string) => ipcRenderer.invoke("worker-invoke", "localServers.testPort", { port, bindAddress }) as Promise<PortTestResult>,
    openFolder: (id: string) => ipcRenderer.invoke("worker-invoke", "localServers.openFolder", { id }) as Promise<{ opened: boolean }>,
    openLog: (id: string) => ipcRenderer.invoke("worker-invoke", "localServers.openLog", { id }) as Promise<{ opened: boolean }>,
    saveLog: (id: string) => ipcRenderer.invoke("save-local-server-log", id) as Promise<{ saved: boolean }>,
    backups: (id: string) => ipcRenderer.invoke("worker-invoke", "localServers.backups", { id }) as Promise<LocalServerBackup[]>,
    rollback: (id: string, backupId: string) => ipcRenderer.invoke("worker-invoke", "localServers.rollback", { id, backupId }) as Promise<LocalServerProfile>,
  },
  getStartupState: () => ipcRenderer.invoke("get-startup-state") as Promise<StartupState>,
  onStartupState(listener: (state: StartupState) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: StartupState) => listener(value);
    ipcRenderer.on("startup-state", handler);
    return () => ipcRenderer.removeListener("startup-state", handler);
  },
  onEvent(listener: (event: WorkerEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: WorkerEvent) => listener(value);
    ipcRenderer.on("worker-event", handler);
    return () => ipcRenderer.removeListener("worker-event", handler);
  },
  onDiscordStatus(listener: (status: { status: DiscordPresenceStatus }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, value: { status: DiscordPresenceStatus }) => listener(value);
    ipcRenderer.on("discord-status", handler);
    return () => ipcRenderer.removeListener("discord-status", handler);
  },
  minimize: () => ipcRenderer.send("window-minimize"),
  toggleMaximize: () => ipcRenderer.send("window-toggle-maximize"),
  close: () => ipcRenderer.send("window-close"),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  pickContentBundle: () => ipcRenderer.invoke("pick-content-bundle") as Promise<string | null>,
  pickLocalServerArchive: () => ipcRenderer.invoke("pick-local-server-archive") as Promise<string | null>,
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
