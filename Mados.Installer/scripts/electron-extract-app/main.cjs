const { app } = require("electron");
const { shell } = require("electron");
const { extractArchive } = require("../../dist/main/zip-safety.js");
const { installStagedApp } = require("../../dist/main/install-files.js");
const { createWindowsShortcuts } = require("../../dist/main/shortcuts.js");
const fs = require("node:fs/promises");
const path = require("node:path");

const zipPath = process.argv.at(-2);
const resultPath = process.argv.at(-1);

app.whenReady().then(async () => {
  const stagingPath = path.join(path.dirname(resultPath), `mados-installer-electron-staging-${process.pid}`);
  try {
    const executablePath = await extractArchive(zipPath, stagingPath, () => undefined);
    const installPath = path.join(path.dirname(resultPath), `mados-installer-install-${process.pid}`);
    const installed = await installStagedApp(stagingPath, installPath);
    let shortcuts = { created: [], failed: [] };
    if (process.platform === "win32") {
      shortcuts = await createWindowsShortcuts({
        desktopDirectory: path.join(path.dirname(resultPath), "Desktop"),
        appDataDirectory: path.join(path.dirname(resultPath), "AppData"),
        executablePath: installed.executablePath,
        makeDirectory: (directory) => fs.mkdir(directory, { recursive: true }),
        writeShortcut: (shortcutPath, operation, options) => shell.writeShortcutLink(shortcutPath, operation, options),
      });
      if (shortcuts.failed.length > 0) throw new Error(`Shortcut creation failed: ${shortcuts.failed.join(", ")}`);
    }
    await fs.writeFile(resultPath, JSON.stringify({ ok: true, executablePath, installedExecutablePath: installed.executablePath, shortcuts }));
  } catch (error) {
    await fs.writeFile(resultPath, JSON.stringify({ ok: false, code: error?.code, message: error?.message, cause: error?.cause?.message }));
  } finally {
    app.exit(0);
  }
});
