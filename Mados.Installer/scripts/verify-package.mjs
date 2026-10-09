import { access, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

export class PackageVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PackageVerificationError";
    this.code = code;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(root, current = root, entries = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    entries.push(relative(root, path));
    if (entry.isDirectory()) await walk(root, path, entries);
  }
  return entries;
}

async function packageEntries(appArchive) {
  if (await exists(appArchive) && (await readdir(appArchive).catch(() => null))) return walk(appArchive);
  if (!(await exists(appArchive))) return [];
  try {
    const { listPackage } = await import("@electron/asar");
    return await listPackage(appArchive);
  } catch {
    return [];
  }
}

export async function verifyPackage(packagePath) {
  const entries = await walk(packagePath);
  const archiveEntries = await packageEntries(join(packagePath, "resources", "app.asar"));
  const allEntries = [...entries, ...archiveEntries.map((entry) => `resources/app.asar/${entry}`)];
  const forbidden = allEntries.filter((entry) => {
    const normalized = entry.replaceAll("\\", "/").toLowerCase();
    return normalized.split("/").includes("worker") || basename(normalized) === "mados launcher.exe";
  });
  if (forbidden.length > 0) throw new PackageVerificationError("PACKAGE_EMBEDDED_PAYLOAD", "Installer package contains Mados Launcher payload files");

  const required = [
    "resources/app.asar/dist/main/main.js",
    "resources/app.asar/dist/preload/preload.js",
    "resources/app.asar/dist/renderer/index.html",
  ];
  const normalized = allEntries.map((entry) => entry.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^\/+/, "").toLowerCase());
  const missing = required.filter((entry) => !normalized.includes(entry.toLowerCase()));
  if (!normalized.some((entry) => entry.startsWith("resources/app.asar/dist/renderer/assets/cat-logo") && entry.endsWith(".png"))) missing.push("resources/app.asar/dist/renderer/assets/cat-logo*.png");
  if (missing.length > 0) throw new PackageVerificationError("PACKAGE_INCOMPLETE", `Installer package is missing: ${missing.join(", ")}`);
  return { valid: true, forbidden: [] };
}

if (process.argv[1] && process.argv[1].endsWith("verify-package.mjs")) {
  const packagePath = process.argv[2];
  if (!packagePath) throw new PackageVerificationError("PACKAGE_PATH", "Package path is required");
  verifyPackage(packagePath).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
