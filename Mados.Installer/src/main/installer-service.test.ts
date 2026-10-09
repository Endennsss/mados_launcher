import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallerFailure, type DownloadProgress, type ReleaseInfo } from "../contracts/installer";
import { InstallerService, getDefaultInstallDirectory, type InstallerDependencies, type InstallerEventSink } from "./installer-service";

const release: ReleaseInfo = {
  tagName: "v0.40.3",
  version: "0.40.3",
  name: "Mados Launcher 0.40.3",
  publishedAt: "2026-10-09T12:00:00.000Z",
  sizeBytes: 10,
  assetName: "Mados.Launcher.Windows.x64.zip",
  assetUrl: "https://github.com/Endennsss/mados_launcher/releases/download/v0.40.3/Mados.Launcher.Windows.x64.zip",
};

const progress: DownloadProgress = { receivedBytes: 10, totalBytes: 10, percent: 100 };

function events(): { sink: InstallerEventSink; stages: string[]; errors: unknown[]; progress: DownloadProgress[] } {
  const stages: string[] = [];
  const errors: unknown[] = [];
  const progressValues: DownloadProgress[] = [];
  return {
    stages,
    errors,
    progress: progressValues,
    sink: {
      stage: (stage) => stages.push(stage),
      progress: (value) => progressValues.push(value),
      error: (value) => errors.push(value),
    },
  };
}

function dependencies(overrides: Partial<InstallerDependencies> = {}): InstallerDependencies {
  return {
    fetchRelease: vi.fn(async () => release),
    validateDirectory: vi.fn(async (directory) => directory),
    closeLauncher: vi.fn(async () => undefined),
    makeTempDirectory: vi.fn(async () => "C:\\Temp\\mados-installer"),
    download: vi.fn(async (_url, _destination, _signal, report) => report(progress)),
    extract: vi.fn(async (_zip, staging, report) => { report("extracting"); return `${staging}\\Mados Launcher.exe`; }),
    install: vi.fn(async (_staging, installPath) => ({ executablePath: `${installPath}\\Mados Launcher.exe`, backupPath: null })),
    removeTempDirectory: vi.fn(async () => undefined),
    launch: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("InstallerService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("permits retry and preserves the original error when cleanup fails", async () => {
    const deps = dependencies({
      download: vi.fn(async () => { throw new InstallerFailure("DOWNLOAD_HTTP", "failed", true); }),
      removeTempDirectory: vi.fn(async () => { throw new Error("locked"); }),
    });
    const service = new InstallerService(deps);
    await expect(service.install("C:\\Mados", events().sink)).rejects.toMatchObject({ code: "DOWNLOAD_HTTP" });
    await expect(service.install("C:\\Mados", events().sink)).rejects.toMatchObject({ code: "DOWNLOAD_HTTP" });
  });

  it("emits the real installation stages in order and launches the verified executable", async () => {
    const deps = dependencies();
    const service = new InstallerService(deps);
    const output = events();

    await expect(service.install("C:\\Mados", output.sink)).resolves.toBe("C:\\Mados\\Mados Launcher.exe");
    expect(output.stages).toEqual(["checking", "downloading", "extracting", "installing", "launching", "completed"]);
    expect(output.progress).toEqual([progress]);
    expect(deps.launch).toHaveBeenCalledWith("C:\\Mados\\Mados Launcher.exe");
    expect(output.errors).toEqual([]);
  });

  it("cancels before replacement and emits an error", async () => {
    const deps = dependencies({
      download: vi.fn(async (_url, _destination, _signal, _report) => undefined),
    });
    const service = new InstallerService(deps);
    const output = events();

    const operation = service.install("C:\\Mados", output.sink);
    service.cancel();
    await expect(operation).rejects.toMatchObject({ code: "DOWNLOAD_CANCELLED" });
    expect(deps.install).not.toHaveBeenCalled();
    expect(output.stages).toContain("error");
    expect(output.errors).toHaveLength(1);
  });

  it("cleans the temporary directory after a failed download", async () => {
    const deps = dependencies({
      download: vi.fn(async () => { throw new InstallerFailure("DOWNLOAD_HTTP", "failed", true); }),
    });
    const service = new InstallerService(deps);
    const output = events();

    await expect(service.install("C:\\Mados", output.sink)).rejects.toMatchObject({ code: "DOWNLOAD_HTTP" });
    expect(deps.removeTempDirectory).toHaveBeenCalledWith("C:\\Temp\\mados-installer");
  });

  it("rejects a launch path that is not the verified Mados executable", async () => {
    const deps = dependencies({
      install: vi.fn(async (_staging, installPath) => ({ executablePath: `${installPath}\\other.exe`, backupPath: null })),
    });
    const service = new InstallerService(deps);
    const output = events();

    await expect(service.install("C:\\Mados", output.sink)).rejects.toMatchObject({ code: "INSTALL_EXECUTABLE" });
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it("chooses platform-appropriate default directories", () => {
    expect(getDefaultInstallDirectory("win32", { LOCALAPPDATA: "C:\\Users\\A\\AppData\\Local" }, "C:\\Users\\A")).toBe("C:\\Users\\A\\AppData\\Local\\Programs\\Mados Launcher");
    expect(getDefaultInstallDirectory("linux", { XDG_DATA_HOME: "/tmp/data" }, "/home/a")).toBe("/tmp/data/Mados Launcher");
  });
});
