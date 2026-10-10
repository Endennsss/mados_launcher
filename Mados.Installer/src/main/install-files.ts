import { fsp } from "./fs-compat";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { InstallerFailure } from "../contracts/installer";
import { fileExists, validateInstallDirectory, assertNoLinks } from "./path-policy";

const PROTECTED_DIRECTORIES = new Set(["data", "launcher"]);
async function copyUserData(source: string, staging: string): Promise<void> {
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    if (!PROTECTED_DIRECTORIES.has(entry.name.toLowerCase()) && !/\.db(?:-wal|-shm)?$/i.test(entry.name)) continue;
    const from = join(source, entry.name);
    await fsp.cp(from, join(staging, entry.name), {
      recursive: true, force: true,
      filter: async (path) => {
        if ((await fsp.lstat(path)).isSymbolicLink()) throw new InstallerFailure("INSTALL_DATA", "В данных установки обнаружена ссылка. Исходные файлы сохранены.", true);
        return true;
      },
    });
  }
}

export async function installStagedApp(
  stagingPath: string,
  installPath: string,
  operations: { rename: (from: string, to: string) => Promise<void> } = { rename: fsp.rename },
): Promise<{ executablePath: string; backupPath: string | null }> {
  installPath = await validateInstallDirectory(installPath);
  stagingPath = resolve(stagingPath);
  await assertNoLinks(stagingPath);
  const stagedExecutable = join(stagingPath, "Mados Launcher.exe");
  if (!(await fileExists(stagedExecutable)) || !(await fsp.lstat(stagedExecutable)).isFile()) {
    throw new InstallerFailure("INSTALL_EXECUTABLE", "В распакованной сборке не найден Mados Launcher.exe", false);
  }
  const overlap = relative(installPath, stagingPath);
  if (!overlap || !overlap.startsWith("..")) throw new InstallerFailure("INSTALL_DIRECTORY", "Временная папка должна быть вне установки", false);
  await fsp.mkdir(dirname(installPath), { recursive: true });
  const hasExisting = await fileExists(installPath);
  // Prepare all user data before moving the old installation. Electron resources
  // belong to the application and must be replaced by the new release.
  if (hasExisting) await copyUserData(installPath, stagingPath);
  await fsp.writeFile(join(stagingPath, ".mados-install.json"), JSON.stringify({ version: 1, installedAt: new Date().toISOString() }));
  const backupPath = hasExisting ? `${installPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}` : null;
  let movedOriginal = false;
  try {
    if (backupPath) {
      await operations.rename(installPath, backupPath);
      movedOriginal = true;
    }
    await operations.rename(stagingPath, installPath);
    return { executablePath: join(installPath, "Mados Launcher.exe"), backupPath };
  } catch {
    // Never remove installPath: the first rename may have failed, or another
    // process may have created something at the destination in the meantime.
    if (movedOriginal && backupPath) {
      try { await operations.rename(backupPath, installPath); }
      catch {
        throw new InstallerFailure("INSTALL_ROLLBACK", `Не удалось восстановить папку автоматически. Предыдущая версия сохранена: ${backupPath}`, true);
      }
    }
    throw new InstallerFailure("INSTALL_REPLACE", "Не удалось заменить установку. Предыдущая версия сохранена. Закройте лаунчер и повторите.", true);
  }
}

