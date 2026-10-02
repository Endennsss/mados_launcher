import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "osx" : "linux";
const architecture = process.arch === "arm64" ? "arm64" : "x64";
const rid = process.env.MADOS_WORKER_RID ?? `${platform}-${architecture}`;
const configuration = process.env.MADOS_WORKER_CONFIGURATION ?? "Release";
const repoRoot = resolve(import.meta.dirname, "..", "..");
const launcherProject = join(repoRoot, "Mados.Worker", "Mados.Worker.csproj");
const stagingRoot = join(import.meta.dirname, "..", "staging", "worker");
const output = join(import.meta.dirname, "..", "staging", "worker", rid);

if (process.env.MADOS_SKIP_WORKER_BUILD === "1") {
  await mkdir(output, { recursive: true });
  console.log(`[mados-worker] skipped publish for ${rid}`);
  process.exit(0);
}

if (!existsSync(launcherProject)) throw new Error(`Launcher project was not found: ${launcherProject}`);
// Packaging must never accidentally include a worker from another RID left by
// a previous local matrix build. Each invocation stages exactly one target.
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const args = [
  "publish",
  launcherProject,
  "--configuration",
  configuration,
  "--runtime",
  rid,
  "--self-contained",
  "true",
  "--output",
  output,
];

// FullRelease enables the production-only compilation symbol used by the
// legacy Avalonia project. Keep Debug worker builds genuinely debuggable while
// preserving the existing Release packaging behavior.
if (configuration.toLowerCase() === "release") args.push("/p:FullRelease=True");

await new Promise((resolvePromise, reject) => {
  const child = spawn("dotnet", args, { cwd: repoRoot, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`dotnet publish failed with exit code ${code}`)));
});
console.log(`[mados-worker] staged ${rid} worker at ${output}`);
