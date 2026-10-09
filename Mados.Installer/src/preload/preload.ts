import { contextBridge, ipcRenderer } from "electron";
import {
  type DownloadProgress,
  type InstallerApi,
  type InstallerError,
  type InstallerStage,
  type InstallerReply,
  installDirectorySchema,
} from "../contracts/installer";

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const reply = await ipcRenderer.invoke(channel, ...args) as InstallerReply<T>;
  if (!reply.ok) throw reply.error;
  return reply.value;
}

const subscribe = <T>(channel: string, handler: (value: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api: InstallerApi = {
  checkRelease: () => invoke("release.check"),
  chooseDirectory: () => invoke("install.chooseDirectory"),
  getDefaultDirectory: () => invoke("install.getDefaultDirectory"),
  startInstall: (directory) => invoke("install.start", installDirectorySchema.parse(directory)),
  cancelInstall: () => invoke("install.cancel"),
  openDirectory: (directory) => invoke("install.openDirectory", installDirectorySchema.parse(directory)),
  quit: () => invoke("app.quit"),
  onStage: (handler) => subscribe<InstallerStage>("installer.stage", handler),
  onProgress: (handler) => subscribe<DownloadProgress>("installer.progress", handler),
  onError: (handler) => subscribe<InstallerError>("installer.error", handler),
};

contextBridge.exposeInMainWorld("madosInstaller", api);
