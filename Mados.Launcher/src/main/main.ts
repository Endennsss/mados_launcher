import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { rendererInvokeSchema } from "../contracts/schema";
import { prepareDataMigration } from "./data-migration";
import { WorkerClient } from "./worker-client";

let windowRef: BrowserWindow | undefined;
const worker = new WorkerClient();
const pendingDeepLinks: string[] = [];

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
    minWidth: 920,
    minHeight: 620,
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

  window.on("ready-to-show", () => window.show());
  window.on("resize", () => applyRoundedWindowShape(window));
  window.on("maximize", () => applyRoundedWindowShape(window));
  window.on("unmaximize", () => applyRoundedWindowShape(window));
  window.on("maximize", () => window.webContents.send("window-state", { maximized: true }));
  window.on("unmaximize", () => window.webContents.send("window-state", { maximized: false }));
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

function trustedSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return Boolean(windowRef && event.sender === windowRef.webContents);
}

function forwardDeepLink(commandLine: string[]): void {
  const uri = commandLine.find((value) => value.startsWith("ss14://") || value.startsWith("ss14s://"));
  if (!uri) return;
  void worker.invoke("app.openDeepLink", { uri }).catch((error) => {
    windowRef?.webContents.send("launcher-error", { message: error instanceof Error ? error.message : String(error) });
  });
}

async function start(): Promise<void> {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", (_event, commandLine) => {
    if (windowRef) {
      if (windowRef.isMinimized()) windowRef.restore();
      windowRef.focus();
    }
    forwardDeepLink(commandLine);
  });

  if (!app.isDefaultProtocolClient("ss14")) app.setAsDefaultProtocolClient("ss14");
  if (!app.isDefaultProtocolClient("ss14s")) app.setAsDefaultProtocolClient("ss14s");

  const migration = await prepareDataMigration();
  if (migration.status === "error") {
    console.error(`[mados-migration] ${migration.message ?? "Migration failed"}`);
  } else if (migration.status === "legacy-compatible") {
    console.info(`[mados-migration] Existing data retained at ${migration.source?.user}`);
  }

  worker.on("event", (event) => windowRef?.webContents.send("worker-event", event));
  worker.on("process-error", (error) => windowRef?.webContents.send("launcher-error", { message: error.message }));
  worker.on("process-exit", (details) => windowRef?.webContents.send("launcher-error", { message: `Worker stopped (${details.code ?? "signal"})` }));
  windowRef = createWindow();
  windowRef.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
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
  windowRef?.webContents.send("worker-event", { v: 1, event, data });
}

app.whenReady().then(start).catch((error) => {
  console.error(error);
  app.quit();
});

// macOS may deliver a custom URL before app.whenReady(). Keep it until the
// worker is alive; Windows/Linux use process.argv and second-instance.
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (windowRef) forwardDeepLink([url]);
  else pendingDeepLinks.push(url);
});

ipcMain.handle("worker-invoke", (event, method: unknown, params?: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted renderer");
  const parsed = rendererInvokeSchema.safeParse({ method, params });
  if (!parsed.success) throw new Error("Unsupported launcher method");
  return worker.invoke(parsed.data.method, parsed.data.params);
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
  if (trustedSender(event)) windowRef?.close();
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
  if (app.isPackaged) autoUpdater.quitAndInstall();
});

app.on("before-quit", () => {
  void worker.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Keep the production bundle honest: a missing renderer is a packaging error,
// not a reason to silently show a blank window.
if (app.isPackaged && !existsSync(join(__dirname, "../renderer/index.html"))) {
  console.error("Mados Launcher renderer bundle is missing");
}
