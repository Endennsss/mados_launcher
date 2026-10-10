import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { INSTALLER_METHODS, installDirectorySchema, InstallerFailure, type InstallerError, type InstallerMethod } from "../contracts/installer";
import { getDefaultInstallDirectory, InstallerService } from "./installer-service";
import { validateInstallDirectory } from "./path-policy";

let mainWindow: BrowserWindow | null = null;
let lastInstalledDirectory: string | null = null;
const installerService = new InstallerService();
const approvedDirectories = new Set([resolve(getDefaultInstallDirectory())]);
const hasSingleInstance = app.requestSingleInstanceLock();
let quitting = false;
let closeRequested = false;
const rendererPath = join(__dirname, "../renderer/index.html");
const developmentUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL === "http://127.0.0.1:5174"
  ? process.env.ELECTRON_RENDERER_URL : null;

function safeError(error: unknown): InstallerError {
  if (error instanceof InstallerFailure) return { code: error.code, message: error.message, retryable: error.retryable };
  return { code: "INSTALLER_INTERNAL", message: "Не удалось выполнить действие. Проверьте доступ к папке и повторите.", retryable: true };
}

function send(channel: string, value: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, value);
}

function assertSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (!mainWindow || event.sender !== mainWindow.webContents || frame !== event.sender.mainFrame ||
      (frame.url !== pathToFileURL(rendererPath).toString() && frame.url !== developmentUrl && frame.url !== developmentUrl + "/")) {
    throw new InstallerFailure("IPC_SENDER", "Недопустимый источник команды", false);
  }
}

function handle(method: InstallerMethod, action: (...args: unknown[]) => unknown): void {
  if (!INSTALLER_METHODS.includes(method)) throw new Error("IPC method not allowed");
  ipcMain.handle(method, async (event, ...args) => {
    try { assertSender(event); return { ok: true, value: await action(...args) }; }
    catch (error) { return { ok: false, error: safeError(error) }; }
  });
}

async function requestQuit(): Promise<void> {
  if (closeRequested || quitting) return;
  closeRequested = true;
  try {
    if (installerService.isBusy && mainWindow) {
      const result = await dialog.showMessageBox(mainWindow, {
        type: "question", title: "Прервать установку?", message: "Закрыть установщик?",
        detail: "Загрузка будет отменена. Если замена файлов уже началась, дождёмся её безопасного завершения.",
        buttons: ["Продолжить установку", "Закрыть"], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response !== 1) return;
    }
    installerService.cancel();
    await installerService.waitForIdle();
    quitting = true;
    app.quit();
  } finally { closeRequested = false; }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 860, height: 700, minWidth: 760, minHeight: 620,
    frame: false, transparent: true, resizable: false, show: false, backgroundColor: "#00000000",
    icon: join(__dirname, "../renderer/assets/cat-logo.ico"),
    webPreferences: { preload: join(__dirname, "../preload/preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (installerService.isBusy && !quitting) { event.preventDefault(); void requestQuit(); }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  const loading = developmentUrl ? mainWindow.loadURL(developmentUrl) : mainWindow.loadFile(rendererPath);
  void loading.catch(() => {
    dialog.showErrorBox("Mados Installer", "Не удалось загрузить интерфейс установщика. Скачайте EXE повторно.");
    app.quit();
  });
}

handle("release.check", async () => {
  send("installer.stage", "checking");
  try {
    const release = await installerService.checkRelease();
    send("installer.stage", "ready");
    return release;
  } catch (error) { send("installer.stage", "error"); throw error; }
});
handle("install.getDefaultDirectory", () => getDefaultInstallDirectory());
handle("install.chooseDirectory", async () => {
  if (installerService.isBusy) throw new InstallerFailure("INSTALL_BUSY", "Дождитесь завершения текущей операции", true);
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Папка Mados Launcher", defaultPath: getDefaultInstallDirectory(), properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const selected = await validateInstallDirectory(result.filePaths[0]);
  approvedDirectories.add(selected);
  return selected;
});
handle("install.start", async (directory) => {
  const selected = resolve(installDirectorySchema.parse(directory));
  if (!approvedDirectories.has(selected)) throw new InstallerFailure("INSTALL_DIRECTORY", "Выберите папку через кнопку «Выбрать папку»", false);
  const insideTarget = relative(selected, process.execPath);
  if (!insideTarget.startsWith("..") && !/^[A-Za-z]:/.test(insideTarget)) {
    throw new InstallerFailure("INSTALL_DIRECTORY", "Переместите установщик за пределы выбранной папки", true);
  }
  await installerService.install(selected, {
    stage: (stage) => send("installer.stage", stage),
    progress: (progress) => send("installer.progress", progress),
    error: (error) => send("installer.error", error),
  });
  lastInstalledDirectory = selected;
  setTimeout(() => { if (!installerService.isBusy) void requestQuit(); }, 2200);
});
handle("install.cancel", () => installerService.cancel());
handle("install.openDirectory", async (directory) => {
  const selected = resolve(installDirectorySchema.parse(directory));
  if (selected !== lastInstalledDirectory) throw new InstallerFailure("DIRECTORY_OPEN", "Установка ещё не завершена", false);
  await validateInstallDirectory(selected);
  await installerService.openDirectory(selected);
});
handle("app.quit", () => { void requestQuit(); });

if (!hasSingleInstance) { quitting = true; app.quit(); }
else app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
});
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  void requestQuit();
});
app.whenReady().then(() => { if (hasSingleInstance) createWindow(); }).catch(() => {
  console.error("Mados Installer failed to start"); app.exit(1);
});
app.on("window-all-closed", () => { void requestQuit(); });

