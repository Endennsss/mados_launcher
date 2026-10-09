import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve, sep, win32 } from "node:path";
import { spawn } from "node:child_process";
import {
  InstallerFailure,
  type DownloadProgress,
  type InstallerError,
  type InstallerStage,
  type ReleaseInfo,
} from "../contracts/installer";
import { fetchLatestRelease } from "./release-client";
import { downloadAsset, type DownloadIntegrity } from "./download";
import { extractArchive } from "./zip-safety";
import { installStagedApp } from "./install-files";
import { validateInstallDirectory } from "./path-policy";
import { closeInstalledLauncher } from "./close-launcher";

export type InstallerEventSink = {
  stage: (stage: InstallerStage) => void;
  progress: (progress: DownloadProgress) => void;
  error: (error: InstallerError) => void;
};

export type InstallerDependencies = {
  fetchRelease: (signal?: AbortSignal) => Promise<ReleaseInfo>;
  validateDirectory: (directory: string) => Promise<string>;
  closeLauncher: (directory: string) => Promise<void>;
  makeTempDirectory: (installPath?: string) => Promise<string>;
  download: (url: string, destination: string, signal: AbortSignal, report: (progress: DownloadProgress) => void, integrity?: DownloadIntegrity) => Promise<void>;
  extract: (zipPath: string, stagingPath: string, report: (stage: InstallerStage) => void, signal?: AbortSignal) => Promise<string>;
  install: (stagingPath: string, installPath: string) => Promise<{ executablePath: string; backupPath: string | null }>;
  removeTempDirectory: (path: string) => Promise<void>;
  launch: (executablePath: string) => Promise<void>;
  openDirectory?: (directory: string) => Promise<void>;
};

export function getDefaultInstallDirectory(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") return win32.join(environment.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"), "Programs", "Mados Launcher");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Mados Launcher");
  return posix.join(environment.XDG_DATA_HOME ?? posix.join(home, ".local", "share"), "Mados Launcher");
}

function toInstallerError(error: unknown): InstallerError {
  if (error instanceof InstallerFailure) return { code: error.code, message: error.message, retryable: error.retryable };
  return { code: "INSTALLER_INTERNAL", message: "Внутренняя ошибка установщика", retryable: true };
}

async function defaultLaunch(executablePath: string): Promise<void> {
  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(executablePath, [], {
      cwd: dirname(executablePath),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  });
}

const defaultDependencies = (): InstallerDependencies => ({
  fetchRelease: (signal) => fetchLatestRelease(fetch, signal),
  validateDirectory: validateInstallDirectory,
  closeLauncher: closeInstalledLauncher,
  makeTempDirectory: async (installPath = tmpdir()) => {
    const parent = dirname(resolve(installPath));
    await mkdir(parent, { recursive: true });
    return mkdtemp(join(parent, ".mados-installer-"));
  },
  download: (url, destination, signal, report, integrity) => downloadAsset(url, destination, signal, report, fetch, integrity),
  extract: extractArchive,
  install: installStagedApp,
  removeTempDirectory: (path) => rm(path, { recursive: true, force: true }),
  launch: defaultLaunch,
  openDirectory: async (directory) => {
    const { shell } = await import("electron");
    const error = await shell.openPath(directory);
    if (error) throw new InstallerFailure("DIRECTORY_OPEN", "Не удалось открыть папку установки", true);
  },
});

export class InstallerService {
  private readonly dependencies: InstallerDependencies;
  private activeAbortController: AbortController | null = null;
  private activeDone: Promise<void> | null = null;
  private resolveActiveDone: (() => void) | null = null;

  constructor(dependencies: Partial<InstallerDependencies> = {}) {
    this.dependencies = { ...defaultDependencies(), ...dependencies };
  }

  async checkRelease(signal?: AbortSignal): Promise<ReleaseInfo> {
    return this.dependencies.fetchRelease(signal);
  }

  async install(directory: string, emit: InstallerEventSink): Promise<string> {
    if (this.activeAbortController) throw new InstallerFailure("INSTALL_BUSY", "Установка уже выполняется", true);
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.activeDone = new Promise<void>((resolveDone) => { this.resolveActiveDone = resolveDone; });
    let temporaryDirectory: string | null = null;

    try {
      directory = await this.dependencies.validateDirectory(directory);
      emit.stage("checking");
      const release = await this.checkRelease(abortController.signal);
      if (abortController.signal.aborted) throw new InstallerFailure("DOWNLOAD_CANCELLED", "Установка отменена", true);

      temporaryDirectory = await this.dependencies.makeTempDirectory(directory);
      const zipPath = join(temporaryDirectory, "release.zip");
      const stagingPath = join(temporaryDirectory, "staging");
      emit.stage("downloading");
      await this.dependencies.download(release.assetUrl, zipPath, abortController.signal, emit.progress, release);
      if (abortController.signal.aborted) throw new InstallerFailure("DOWNLOAD_CANCELLED", "Установка отменена", true);

      const extractedExecutable = await this.dependencies.extract(zipPath, stagingPath, emit.stage, abortController.signal);
      if (abortController.signal.aborted) throw new InstallerFailure("DOWNLOAD_CANCELLED", "Установка отменена", true);

      emit.stage("installing");
      await this.dependencies.closeLauncher(directory);
      if (abortController.signal.aborted) throw new InstallerFailure("DOWNLOAD_CANCELLED", "Установка отменена", true);
      const installed = await this.dependencies.install(stagingPath, directory);
      const expectedRoot = resolve(directory);
      const executablePath = resolve(installed.executablePath);
      if (executablePath !== join(expectedRoot, "Mados Launcher.exe")) {
        throw new InstallerFailure("INSTALL_EXECUTABLE", "Установщик получил неожиданный путь запуска", false);
      }
      if (basename(resolve(extractedExecutable)).toLowerCase() !== "mados launcher.exe") {
        throw new InstallerFailure("INSTALL_EXECUTABLE", "Архив содержит неожиданный executable", false);
      }

      if (abortController.signal.aborted) return executablePath;
      emit.stage("launching");
      await this.dependencies.launch(executablePath);
      emit.stage("completed");
      return executablePath;
    } catch (error) {
      const safeError = toInstallerError(error);
      emit.stage("error");
      emit.error(safeError);
      throw error instanceof InstallerFailure ? error : new InstallerFailure(safeError.code, safeError.message, safeError.retryable);
    } finally {
      try { if (temporaryDirectory) await this.dependencies.removeTempDirectory(temporaryDirectory); }
      catch { console.warn("Mados Installer: temporary files could not be removed; installation result preserved."); }
      finally {
        if (this.activeAbortController === abortController) this.activeAbortController = null;
        this.resolveActiveDone?.();
        this.resolveActiveDone = null;
        this.activeDone = null;
      }
    }
  }

  cancel(): void {
    this.activeAbortController?.abort();
  }

  get isBusy(): boolean { return this.activeAbortController !== null; }

  async waitForIdle(): Promise<void> {
    await this.activeDone;
  }

  async openDirectory(directory: string): Promise<void> {
    await this.dependencies.openDirectory?.(directory);
  }
}
