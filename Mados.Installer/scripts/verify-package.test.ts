import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPackage } from "./verify-package.mjs";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function validPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mados-installer-package-"));
  temporary.push(root);
  await mkdir(join(root, "resources", "app.asar", "dist", "main"), { recursive: true });
  await mkdir(join(root, "resources", "app.asar", "dist", "preload"), { recursive: true });
  await mkdir(join(root, "resources", "app.asar", "dist", "renderer", "assets"), { recursive: true });
  await writeFile(join(root, "resources", "app.asar", "dist", "main", "main.js"), "installer");
  await writeFile(join(root, "resources", "app.asar", "dist", "preload", "preload.js"), "installer");
  await writeFile(join(root, "resources", "app.asar", "dist", "renderer", "index.html"), "installer");
  await writeFile(join(root, "resources", "app.asar", "dist", "renderer", "assets", "cat-logo.png"), "asset");
  return root;
}

describe("verifyPackage", () => {
  it("accepts an installer package with its own bundles and logo", async () => {
    await expect(verifyPackage(await validPackage())).resolves.toEqual({ valid: true, forbidden: [] });
  });

  it("rejects an embedded launcher executable or worker", async () => {
    const root = await validPackage();
    await writeFile(join(root, "Mados Launcher.exe"), "payload");
    await mkdir(join(root, "resources", "worker"), { recursive: true });
    await expect(verifyPackage(root)).rejects.toMatchObject({ code: "PACKAGE_EMBEDDED_PAYLOAD" });
  });
});
