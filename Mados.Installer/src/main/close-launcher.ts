import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { InstallerFailure } from "../contracts/installer";

// The command is constant. The selected path is passed as data, never as shell code.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = $env:MADOS_INSTALLER_CLOSE_TARGET
$apps = @(Get-Process -Name 'Mados Launcher' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target })
foreach ($process in $apps) {
  if (-not $process.CloseMainWindow()) { exit 2 }
}
foreach ($process in $apps) {
  if (-not $process.WaitForExit(15000)) { exit 3 }
}
exit 0
`;

export async function closeInstalledLauncher(directory: string): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")], {
      windowsHide: true, timeout: 20000, env: { ...process.env, MADOS_INSTALLER_CLOSE_TARGET: join(directory, "Mados Launcher.exe") },
    });
  } catch {
    throw new InstallerFailure("INSTALL_RUNNING", "Закройте Mados Launcher в папке установки и повторите. Текущая версия сохранена.", true);
  }
}
