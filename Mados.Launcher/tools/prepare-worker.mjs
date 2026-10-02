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
const loaderProject = join(repoRoot, "SS14.Loader", "SS14.Loader.csproj");
const stagingRoot = join(import.meta.dirname, "..", "staging", "worker");
const output = join(import.meta.dirname, "..", "staging", "worker", rid);
const loaderOutput = join(output, "loader");

if (process.env.MADOS_SKIP_WORKER_BUILD === "1") {
  await mkdir(output, { recursive: true });
  console.log(`[mados-worker] skipped publish for ${rid}`);
  process.exit(0);
}

if (!existsSync(launcherProject)) throw new Error(`Launcher project was not found: ${launcherProject}`);
if (!existsSync(loaderProject)) throw new Error(`Loader project was not found: ${loaderProject}`);
// Packaging must never accidentally include a worker from another RID left by
// a previous local matrix build. Each invocation stages exactly one target.
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(output, { recursive: true });
async function publish(project, destination, fullRelease) {
  const args = [
    "publish",
    project,
    "--configuration",
    configuration,
    "--runtime",
    rid,
    "--self-contained",
    "true",
    "--output",
    destination,
  ];

  // FullRelease enables the production-only worker path while leaving Debug
  // builds debuggable. The loader does not use this symbol, but accepting the
  // same switch keeps both projects on one deterministic publish path.
  if (fullRelease && configuration.toLowerCase() === "release") args.push("/p:FullRelease=True");

  await new Promise((resolvePromise, reject) => {
    const child = spawn("dotnet", args, { cwd: repoRoot, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`dotnet publish failed with exit code ${code}`)));
  });
}

await publish(launcherProject, output, true);
await mkdir(loaderOutput, { recursive: true });
await publish(loaderProject, loaderOutput, false);
console.log(`[mados-worker] staged ${rid} worker and loader at ${output}`);
