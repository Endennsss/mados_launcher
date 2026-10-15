import type { EventEmitter } from "node:events";
import type { ShellUpdateState } from "../contracts/launcher";

type Updater = Pick<EventEmitter, "on" | "removeListener"> & {
  autoDownload: boolean; autoInstallOnAppQuit: boolean; allowPrerelease: boolean; allowDowngrade: boolean;
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>;
  downloadUpdate(): Promise<unknown>; quitAndInstall(silent?: boolean, runAfter?: boolean): void;
};

export class LauncherUpdates {
  private state: ShellUpdateState;
  private initialTimer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private pending?: Promise<ShellUpdateState>;
  private downloading?: Promise<ShellUpdateState>;
  private stopped = false;
  private started = false;
  private readonly handlers: Array<[string, (...args: any[]) => void]> = [];

  constructor(private readonly updater: Updater, private readonly publish: (state: ShellUpdateState) => void, private readonly options: { packaged: boolean; currentVersion: string }) {
    this.state = { status: options.packaged ? "idle" : "disabled", currentVersion: options.currentVersion, revision: 0 };
  }
  snapshot(): ShellUpdateState { return { ...this.state }; }
  private set(next: Partial<ShellUpdateState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, message: undefined, ...next, revision: this.state.revision + 1 };
    this.publish(this.snapshot());
  }
  private fail = (): void => { this.set({ status: "error", message: "Не удалось получить обновление Mados с GitHub. Проверьте соединение и повторите попытку." }); };
  start(): void {
    if (this.started || !this.options.packaged) return;
    this.started = true;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = false;
    this.updater.allowDowngrade = false;
    const listen = (event: string, handler: (...args: any[]) => void) => { this.handlers.push([event, handler]); this.updater.on(event, handler); };
    listen("checking-for-update", () => this.set({ status: "checking" }));
    listen("update-not-available", () => this.set({ status: "idle", version: undefined, percent: undefined, checkedAt: new Date().toISOString() }));
    listen("update-available", (info: { version: string }) => this.set({ status: "available", version: info.version, percent: undefined, checkedAt: new Date().toISOString() }));
    listen("download-progress", (progress: { percent: number }) => this.set({ status: "downloading", percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0 }));
    listen("update-downloaded", (info: { version: string }) => this.set({ status: "downloaded", version: info.version, percent: 100 }));
    listen("error", this.fail);
    this.initialTimer = setTimeout(() => void this.check(), 10_000);
    this.interval = setInterval(() => void this.check(), 3_600_000);
    this.initialTimer.unref?.(); this.interval.unref?.();
  }
  check(): Promise<ShellUpdateState> {
    if (!this.options.packaged || this.stopped || ["downloading", "downloaded"].includes(this.state.status)) return Promise.resolve(this.snapshot());
    if (this.pending) return this.pending;
    this.set({ status: "checking" });
    this.pending = this.updater.checkForUpdates().then(result => {
      if (result === null && this.state.status === "checking") {
        this.set({ status: "disabled", message: "Эта сборка не поддерживает обновление внутри приложения. Новые версии доступны на GitHub Releases." });
        clearTimeout(this.initialTimer); clearInterval(this.interval);
      }
      // Also consume the library's background promise, even if a future
      // configuration enables it, so it cannot become an unhandled rejection.
      if (result?.downloadPromise) void result.downloadPromise.catch(this.fail);
    }).catch(this.fail).then(() => this.snapshot()).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  download(): Promise<ShellUpdateState> {
    if (this.downloading) return this.downloading;
    if (!this.options.packaged || this.stopped || this.state.status !== "available") return Promise.resolve(this.snapshot());
    this.set({ status: "downloading", percent: 0 });
    this.downloading = this.updater.downloadUpdate().catch(this.fail).then(() => this.snapshot()).finally(() => { this.downloading = undefined; });
    return this.downloading;
  }
  canInstall(): boolean { return !this.stopped && this.options.packaged && this.state.status === "downloaded"; }
  install(): boolean {
    if (!this.canInstall()) return false;
    this.updater.quitAndInstall(true, true);
    return true;
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.initialTimer); clearInterval(this.interval);
    for (const [event, handler] of this.handlers) this.updater.removeListener(event, handler);
    // Electron may report a cancelled download while the process exits.
    this.updater.on("error", () => undefined);
  }
}
