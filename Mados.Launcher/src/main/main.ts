import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { existsSync } from "node:fs";
import { copyFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { localServerSnapshotSchema, rendererInvokeSchema, validateRendererParams } from "../contracts/schema";
import type { StartupState } from "../contracts/launcher";
import { DiscordPresenceService } from "./discord-presence";
import { prepareDataMigration } from "./data-migration";
import { containsDeepLink } from "./deep-link";
import { WorkerClient } from "./worker-client";

let windowRef: BrowserWindow | undefined;
let shuttingDown = false;
let shutdownComplete = false;
let closePromptActive = false;
let shutdownRequest: Promise<void> | undefined;
let workerInitialized = false;
let localServerState: unknown;
const approvedLocalServerArchives = new Set<string>();
let startupState: StartupState = { stage: "starting-worker", message: "Запускаем Mados Launcher…" };
const worker = new WorkerClient();
const discordPresence = new DiscordPresenceService((status) => {
  sendToRenderer("discord-status", { status });
});
const pendingDeepLinks: string[] = [];

function sendToRenderer(channel: string, payload: unknown): void {
  const window = windowRef;
  // Worker, Discord and updater callbacks can arrive after the native window
  // closes. Check the window before even accessing its webContents getter.
  if (shuttingDown || !window || window.isDestroyed()) return;
  const contents = window.webContents;
  if (contents.isDestroyed()) return;
  try {
    contents.send(channel, payload);
  } catch (error) {
    // A renderer can be destroyed between the checks above and send(). This
    // is expected during close; never turn that race into an uncaught main
    // process exception.
    if (!(error instanceof Error && /destroyed/i.test(error.message))) {
      console.error("[mados] renderer event delivery failed", error);
    }
  }
}

function setStartupState(next: StartupState): void {
  startupState = next;
  sendToRenderer("startup-state", next);
}

/**
 * CSS clips the renderer, but a transparent frameless BrowserWindow is still
 * rectangular at the native layer on some Windows builds. Keep the native
 * hit-test/drawing region in sync with the renderer so desktop pixels cannot
 * leak through as square corners.
 */
function applyRoundedWindowShape(window: BrowserWindow): void {
  if (process.platform !== "win32" && process.platform !== "linux") return;
  try {
    const [width, height] = window.getSize();
    if (window.isMaximized() || width < 2 || height < 2) {
      window.setShape([]);
      return;
    }

    const radius = Math.min(20, Math.floor(Math.min(width, height) / 2));
    if (radius <= 0) {
      window.setShape([]);
      return;
    }

    const rows = [{ x: 0, y: radius, width, height: height - radius * 2 }];
    for (let y = 0; y < radius; y += 1) {
      const distance = radius - y - 0.5;
      const inset = Math.max(0, Math.ceil(radius - Math.sqrt(radius * radius - distance * distance)));
      const rowWidth = Math.max(1, width - inset * 2);
      rows.push({ x: inset, y, width: rowWidth, height: 1 });
      rows.push({ x: inset, y: height - y - 1, width: rowWidth, height: 1 });
    }
    window.setShape(rows);
  } catch {
    // Older Electron/Windows combinations can expose no native shape API.
    // The renderer still has the CSS clipping fallback in that case.
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: "#00000000",
    title: "Mados Launcher",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  });

  window.on("ready-to-show", () => {
    if (!shuttingDown && !window.isDestroyed()) window.show();
  });
  window.on("closed", () => {
    if (windowRef === window) windowRef = undefined;
  });
  window.on("close", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    requestShutdown();
  });
  window.on("resize", () => applyRoundedWindowShape(window));
  window.on("maximize", () => applyRoundedWindowShape(window));
  window.on("unmaximize", () => applyRoundedWindowShape(window));
  window.on("maximize", () => sendToRenderer("window-state", { maximized: true }));
  window.on("unmaximize", () => sendToRenderer("window-state", { maximized: false }));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
      ? url.startsWith(process.env.ELECTRON_RENDERER_URL)
      : url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  applyRoundedWindowShape(window);

  return window;
}

function isActiveLocalServerStatus(value: unknown): boolean {
  const result = localServerSnapshotSchema.safeParse(value);
  return result.success && (["running", "starting", "stopping"].includes(result.data.status) || result.data.pid !== null);
}

function requestShutdown(installUpdate = false): void {
  if (shutdownRequest || shutdownComplete) return;
  closePromptActive = true;
  shutdownRequest = performShutdown(installUpdate).catch((error) => {
    console.error("[mados] Shutdown failed", error);
    shuttingDown = false;
    sendToRenderer("launcher-error", { message: "Не удалось корректно завершить работу. Повторите закрытие." });
  }).finally(() => {
    closePromptActive = false;
    if (!shutdownComplete) shutdownRequest = undefined;
  });
}

async function performShutdown(installUpdate: boolean): Promise<void> {
  // During startup there cannot yet be a server started by the renderer. Do
  // not await WorkerClient.ready here: closing a failed startup must still work.
  if (workerInitialized) {
    try {
      localServerState = await withDeadline(worker.invoke("localServers.getStatus", {}), 1500);
    } catch {
      // Use the last real process event if the worker is temporarily busy.
    }
  }
  if (isActiveLocalServerStatus(localServerState)) {
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      title: "Локальный сервер работает",
      message: installUpdate ? "Остановить сервер и установить обновление?" : "Остановить сервер и закрыть Mados Launcher?",
      detail: "Логи сохранятся. Лаунчер дождётся завершения процесса сервера.",
      buttons: ["Отменить", installUpdate ? "Остановить и обновить" : "Остановить и закрыть"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const owner = windowRef;
    const result = owner && !owner.isDestroyed()
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    if (result.response !== 1) return;
  }
  shuttingDown = true;
  // Worker shutdown owns the graceful stop, process-tree cleanup, and log flush.
  // Its deadline must not be cut short by a separate Electron quit timer.
  const results = await Promise.allSettled([withDeadline(discordPresence.stop(), 5000), worker.stop()]);
  for (const result of results) {
    if (result.status === "rejected") console.error("[mados] Service shutdown failed", result.reason);
  }
  shutdownComplete = true;
  if (installUpdate && app.isPackaged) autoUpdater.quitAndInstall();
  else app.quit();
}

async function withDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Operation timed out")), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveLocalServerPath(method: "localServers.openFolder" | "localServers.openLog", params: unknown): Promise<string> {
  const result = await worker.invoke<{ path?: unknown }>(method, params);
  if (typeof result.path !== "string" || !isAbsolute(result.path)) throw new Error("Локальный путь недоступен.");
  const path = await realpath(result.path);
  const info = await stat(path);
  if (method === "localServers.openFolder" ? !info.isDirectory() : !info.isFile() || !/\.(?:log|txt)$/i.test(path)) {
    throw new Error("Локальный файл или папка недоступны.");
  }
  return path;
}

function trustedSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return Boolean(!shuttingDown && !closePromptActive && windowRef && !windowRef.isDestroyed() && event.sender === windowRef.webContents);
}

function forwardDeepLink(commandLine: string[]): void {
  if (shuttingDown) return;
  const uri = commandLine.find((value) => containsDeepLink([value]));
  if (!uri) return;
  void worker.invoke("app.openDeepLink", { uri }).catch((error) => {
    sendToRenderer("launcher-error", { message: error instanceof Error ? error.message : String(error) });
  });
}

async function start(): Promise<void> {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", (_event, commandLine) => {
    if (!shuttingDown && windowRef && !windowRef.isDestroyed()) {
      if (windowRef.isMinimized()) windowRef.restore();
      windowRef.focus();
    }
    forwardDeepLink(commandLine);
  });

  if (!app.isDefaultProtocolClient("ss14")) app.setAsDefaultProtocolClient("ss14");
  if (!app.isDefaultProtocolClient("ss14s")) app.setAsDefaultProtocolClient("ss14s");

  windowRef = createWindow();
  windowRef.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  setStartupState({ stage: "checking-data", message: "Проверяем данные…" });
  const migration = await prepareDataMigration();
  if (shuttingDown) return;
  if (migration.status === "error") {
    console.error(`[mados-migration] ${migration.message ?? "Migration failed"}`);
  } else if (migration.status === "legacy-compatible") {
    console.info(`[mados-migration] Existing data retained at ${migration.source?.user}`);
  }

  worker.on("event", (event) => {
    if (event.event === "localServer.status" && localServerSnapshotSchema.safeParse(event.data).success) localServerState = event.data;
    if (shuttingDown) return;
    if (event.event === "app.startup" && event.data?.stage === "checking-data") setStartupState({ stage: "checking-data", message: "Проверяем данные…" });
    if (event.event === "app.ready") {
      workerInitialized = true;
      setStartupState({ stage: "loading-ui", message: "Загружаем интерфейс…" });
    }
    discordPresence.handleWorkerEvent(event);
    sendToRenderer("worker-event", event);
  });
  worker.on("process-error", (error) => sendToRenderer("launcher-error", { message: error.message }));
  worker.on("process-exit", (details) => {
    workerInitialized = false;
    sendToRenderer("launcher-error", { message: `Worker stopped (${details.code ?? "signal"})` });
  });
  setStartupState({ stage: "starting-worker", message: "Запускаем worker…" });
  worker.start();
  setupAutoUpdater();
  forwardDeepLink(process.argv);
  for (const uri of pendingDeepLinks.splice(0)) forwardDeepLink([uri]);
}

function setupAutoUpdater(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => sendShellUpdateEvent("shell.updateChecking", {}));
  autoUpdater.on("update-available", (info) => sendShellUpdateEvent("shell.updateAvailable", { version: info.version }));
  autoUpdater.on("update-not-available", () => sendShellUpdateEvent("shell.updateNotAvailable", {}));
  autoUpdater.on("download-progress", (progress) => sendShellUpdateEvent("shell.updateProgress", { percent: progress.percent, bytesPerSecond: progress.bytesPerSecond }));
  autoUpdater.on("update-downloaded", (info) => sendShellUpdateEvent("shell.updateDownloaded", { version: info.version }));
  autoUpdater.on("error", (error) => sendShellUpdateEvent("shell.updateError", { message: error.message }));
  void autoUpdater.checkForUpdates().catch((error: Error) => sendShellUpdateEvent("shell.updateError", { message: error.message }));
}

function sendShellUpdateEvent(event: string, data: unknown): void {
  sendToRenderer("worker-event", { v: 1, event, data });
}

app.whenReady().then(start).catch((error) => {
  console.error(error);
  app.quit();
});

// macOS may deliver a custom URL before app.whenReady(). Keep it until the
// worker is alive; Windows/Linux use process.argv and second-instance.
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (shuttingDown) return;
  if (windowRef) forwardDeepLink([url]);
  else pendingDeepLinks.push(url);
});

ipcMain.handle("worker-invoke", async (event, method: unknown, params?: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted renderer");
  const parsed = rendererInvokeSchema.safeParse({ method, params });
  if (!parsed.success) throw new Error("Unsupported launcher method");
  let safeParams: unknown;
  try {
    safeParams = validateRendererParams(parsed.data.method, parsed.data.params);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Invalid launcher parameters");
  }
  let approvedArchivePath: string | undefined;
  if ((parsed.data.method === "tools.cdn.import" || parsed.data.method === "localServers.create") && safeParams && typeof safeParams === "object" && "localPath" in safeParams) {
    const localPath = (safeParams as { localPath?: unknown }).localPath;
    if (typeof localPath !== "string" || !approvedLocalServerArchives.has(resolve(localPath))) {
      throw new Error("Local server archives must be selected with the launcher file picker");
    }
    approvedArchivePath = resolve(localPath);
  }
  if (parsed.data.method === "app.shutdown") {
    requestShutdown();
    return { requested: true };
  }
  if (parsed.data.method === "localServers.openFolder" || parsed.data.method === "localServers.openLog") {
    const path = await resolveLocalServerPath(parsed.data.method, safeParams);
    const error = await shell.openPath(path);
    if (error) throw new Error("Не удалось открыть выбранный файл или папку.");
    return { opened: true };
  }
  let result: unknown;
  try {
    result = await worker.invoke(parsed.data.method, safeParams);
  } finally {
    if (approvedArchivePath) approvedLocalServerArchives.delete(approvedArchivePath);
  }
  if (parsed.data.method === "app.getState" && workerInitialized) setStartupState({ stage: "ready", message: "Готово" });
  return result;
});
ipcMain.on("window-minimize", (event) => {
  if (trustedSender(event)) windowRef?.minimize();
});
ipcMain.on("window-toggle-maximize", (event) => {
  if (!trustedSender(event)) return;
  if (windowRef?.isMaximized()) windowRef.unmaximize();
  else windowRef?.maximize();
});
ipcMain.on("window-close", (event) => {
  if (trustedSender(event)) requestShutdown();
});
ipcMain.handle("open-external", async (event, url: unknown) => {
  if (!trustedSender(event) || typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("Only HTTPS/HTTP external links are allowed");
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw new Error("External link credentials are not allowed");
  await shell.openExternal(parsed.toString());
});
ipcMain.handle("pick-content-bundle", async (event) => {
  if (!trustedSender(event) || !windowRef) throw new Error("Untrusted renderer");
  const result = await dialog.showOpenDialog(windowRef, {
    title: "Select replay or content bundle",
    properties: ["openFile"],
    filters: [{ name: "Replay or content bundle", extensions: ["zip"] }],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});
ipcMain.handle("pick-local-server-archive", async (event) => {
  if (!trustedSender(event) || !windowRef) throw new Error("Untrusted renderer");
  const result = await dialog.showOpenDialog(windowRef, {
    title: "Select local SS14 server archive",
    properties: ["openFile"],
    filters: [{ name: "Server archive", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const selected = await realpath(result.filePaths[0]);
  if (!/\.zip$/i.test(selected) || !(await stat(selected)).isFile()) throw new Error("Выберите ZIP-архив сервера.");
  approvedLocalServerArchives.add(selected);
  return selected;
});
ipcMain.handle("save-local-server-log", async (event, id: unknown) => {
  if (!trustedSender(event) || !windowRef) throw new Error("Untrusted renderer");
  const params = validateRendererParams("localServers.openLog", { id });
  const path = await resolveLocalServerPath("localServers.openLog", params);
  if (!windowRef || windowRef.isDestroyed() || shuttingDown) return { saved: false };
  const defaultPath = join(app.getPath("documents"), "mados-server.log");
  const target = await dialog.showSaveDialog(windowRef, {
    title: "Сохранить лог локального сервера",
    defaultPath,
    filters: [{ name: "Log file", extensions: ["log", "txt"] }],
  });
  if (target.canceled || !target.filePath) return { saved: false };
  await copyFile(path, target.filePath);
  return { saved: true };
});
ipcMain.handle("get-startup-state", (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted renderer");
  return startupState;
});
ipcMain.handle("check-for-updates", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted renderer");
  if (!app.isPackaged) return { available: false, development: true };
  const result = await autoUpdater.checkForUpdates();
  return { available: Boolean(result?.updateInfo) };
});
ipcMain.handle("download-update", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted renderer");
  if (!app.isPackaged) return { downloaded: false, development: true };
  await autoUpdater.downloadUpdate();
  return { downloaded: true };
});
ipcMain.on("install-update", (event) => {
  if (!trustedSender(event)) return;
  if (app.isPackaged) requestShutdown(true);
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  requestShutdown();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Keep the production bundle honest: a missing renderer is a packaging error,
// not a reason to silently show a blank window.
if (app.isPackaged && !existsSync(join(__dirname, "../renderer/index.html"))) {
  console.error("Mados Launcher renderer bundle is missing");
}
