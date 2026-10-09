import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, win32 } from "node:path";
import { InstallerFailure } from "../contracts/installer";

export function normalizeInstallDirectory(value: string): string {
  const invalidWindows = process.platform === "win32" && (
    !/^[a-z]:[\\/]/i.test(value) ||
    value.slice(2).split(/[\\/]/).filter(Boolean).some((part) => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
    win32.isAbsolute(value) && value.startsWith("\\\\")
  );
  if (!value || value.includes("\0") || !isAbsolute(value) || value !== value.trim() || invalidWindows) {
    throw new InstallerFailure("INSTALL_DIRECTORY", "Выберите локальную папку установки", true);
  }
  const result = resolve(value);
  if (result === parse(result).root) throw new InstallerFailure("INSTALL_DIRECTORY", "Нельзя установить лаунчер в корень диска", true);
  return result;
}

export async function fileExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function assertNoLinks(path: string): Promise<void> {
  let cursor = resolve(path);
  while (true) {
    if (await fileExists(cursor) && (await lstat(cursor)).isSymbolicLink()) {
      throw new InstallerFailure("INSTALL_DIRECTORY", "Выберите папку без символических ссылок и junction", true);
    }
    if (dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
}

export async function validateInstallDirectory(value: string): Promise<string> {
  const directory = normalizeInstallDirectory(value);
  await assertNoLinks(directory);
  if (await fileExists(directory)) {
    if (!(await lstat(directory)).isDirectory()) throw new InstallerFailure("INSTALL_DIRECTORY", "Путь установки должен быть папкой", true);
    const entries = await readdir(directory);
    if (entries.length > 0 && !(await isLauncherDirectory(directory))) {
      throw new InstallerFailure("INSTALL_DIRECTORY", "Папка содержит другие файлы. Выберите пустую папку или текущую установку Mados Launcher.", true);
    }
  }
  return directory;
}

export async function isLauncherDirectory(directory: string): Promise<boolean> {
  for (const file of ["Mados Launcher.exe", join("resources", "app.asar")]) {
    const path = join(directory, file);
    if (!(await fileExists(path))) return false;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
  }
  return true;
}
