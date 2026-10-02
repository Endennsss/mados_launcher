import { app } from "electron";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The C# services still own the historic Space Station 14 data directories.
 * Migration therefore adopts those directories in place instead of moving or
 * duplicating engine/content caches. A dated metadata backup and a marker make
 * the decision explicit and allow a future resolver to move data safely.
 */
export type MigrationResult = {
  status: "fresh" | "legacy-compatible" | "already-complete" | "error";
  markerPath: string;
  source?: { user: string; local: string };
  backupPath?: string;
  copiedFiles?: string[];
  message?: string;
};

type MigrationMarker = {
  version: 1;
  completedAt: string;
  appVersion: string;
  mode: "fresh" | "legacy-compatible";
  source?: { user: string; local: string };
  backupPath?: string;
  copiedFiles: string[];
  largeDataPreserved: string[];
  legacyProcessStopped?: boolean;
};

const markerFileName = "migration-v1.json";
// settings.db contains accounts/favorites; override_assets.db is small metadata.
// The potentially large content database remains in the legacy cache and is
// resolved in place by the C# worker.
const metadataFiles = ["settings.db", "override_assets.db"] as const;
const largeDataDirectories = ["engines", "modules", "server content", "logs"] as const;
const execFileAsync = promisify(execFile);

export function legacyDataRoots(): { user: string; local: string } {
  const home = app.getPath("home");
  if (process.platform === "win32") {
    const roaming = app.getPath("appData");
    const local = process.env.LOCALAPPDATA ?? roaming;
    return {
      user: join(roaming, "Space Station 14", "launcher"),
      local: join(local, "Space Station 14", "launcher"),
    };
  }

  if (process.platform === "darwin") {
    const applicationSupport = join(home, "Library", "Application Support");
    return {
      user: join(applicationSupport, "Space Station 14", "launcher"),
      local: join(applicationSupport, "Space Station 14", "launcher"),
    };
  }

  const dataHome = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return {
    user: join(dataHome, "Space Station 14", "launcher"),
    local: join(dataHome, "Space Station 14", "launcher"),
  };
}

function hasLegacyData(roots: { user: string; local: string }): boolean {
  return [...metadataFiles.map((file) => join(roots.user, file)), ...metadataFiles.map((file) => join(roots.local, file)), ...largeDataDirectories.map((directory) => join(roots.user, directory))].some(existsSync);
}

async function copyIfPresent(source: string, target: string, copied: string[]): Promise<void> {
  if (!existsSync(source)) return;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  copied.push(source);
}

async function stopConflictingLegacyProcess(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const result = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq SS14.Launcher.exe", "/FO", "CSV", "/NH"]);
    if (!result.stdout.includes("SS14.Launcher.exe")) return false;
    await execFileAsync("taskkill", ["/IM", "SS14.Launcher.exe", "/T", "/F"]);
    return true;
  } catch {
    // The old launcher may not be installed or may exit between tasklist and
    // taskkill. Keeping the old data intact is safer than failing startup.
    return false;
  }
}

/** Run once before the worker starts. It never deletes, moves, or overwrites legacy data. */
export async function prepareDataMigration(): Promise<MigrationResult> {
  const markerPath = join(app.getPath("userData"), markerFileName);
  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as MigrationMarker;
      return {
        status: "already-complete",
        markerPath,
        source: marker.source,
        backupPath: marker.backupPath,
        copiedFiles: marker.copiedFiles,
      };
    } catch {
      // A corrupt marker is recoverable: preserve it and create a new dated
      // marker below rather than silently trusting incomplete migration state.
      await copyIfPresent(markerPath, `${markerPath}.corrupt-${Date.now()}`, []);
    }
  }

  const roots = legacyDataRoots();
  const legacy = hasLegacyData(roots);
  const copiedFiles: string[] = [];
  let backupPath: string | undefined;

  try {
    const legacyProcessStopped = legacy ? await stopConflictingLegacyProcess() : false;
    if (legacy) {
      backupPath = join(app.getPath("userData"), "migration-backups", new Date().toISOString().replace(/[:.]/g, "-"));
      await mkdir(backupPath, { recursive: true });
      for (const file of metadataFiles) {
        await copyIfPresent(join(roots.user, file), join(backupPath, "user", file), copiedFiles);
        if (roots.local !== roots.user) {
          await copyIfPresent(join(roots.local, file), join(backupPath, "local", file), copiedFiles);
        }
      }
    }

    const marker: MigrationMarker = {
      version: 1,
      completedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      mode: legacy ? "legacy-compatible" : "fresh",
      ...(legacy ? { source: roots, backupPath } : {}),
      copiedFiles,
      largeDataPreserved: legacy ? largeDataDirectories.map((directory) => join(roots.user, directory)) : [],
      ...(legacyProcessStopped ? { legacyProcessStopped: true } : {}),
    };
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");

    return {
      status: legacy ? "legacy-compatible" : "fresh",
      markerPath,
      ...(legacy ? { source: roots, backupPath } : {}),
      copiedFiles,
    };
  } catch (error) {
    return {
      status: "error",
      markerPath,
      ...(legacy ? { source: roots, backupPath } : {}),
      copiedFiles,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
