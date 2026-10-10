const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { zipSync } = require("fflate");

const root = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mados-installer-electron-"));
const zipPath = path.join(temporary, "release.zip");
const resultPath = path.join(temporary, "result.json");
const suppliedArchive = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (suppliedArchive) {
  fs.copyFileSync(suppliedArchive, zipPath);
} else {
  fs.writeFileSync(zipPath, zipSync({
    "Mados Launcher.exe": Buffer.from("launcher"),
    "resources/app.asar": Buffer.from("asar payload"),
  }));
}

const electronEntry = path.join(__dirname, "electron-extract-app");
const electronPackage = require.resolve("electron", { paths: [root] });
const electronExecutable = path.join(path.dirname(electronPackage), "dist", process.platform === "win32" ? "electron.exe" : "electron");
const result = childProcess.spawnSync(electronExecutable, ["--no-sandbox", electronEntry, zipPath, resultPath], {
  cwd: root,
  encoding: "utf8",
  timeout: 120_000,
  windowsHide: true,
});

try {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Electron exited with ${result.status}: ${result.stderr || ""}`);
  const payload = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  if (!payload.ok) throw new Error(`Electron extraction failed: ${payload.code}: ${payload.message} (${payload.cause || "no cause"})`);
  if (!fs.statSync(payload.installedExecutablePath).isFile()) throw new Error("Electron installer did not produce executable files");
  console.log("Electron installer extraction and install smoke passed");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
