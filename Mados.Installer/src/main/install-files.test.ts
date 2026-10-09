import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStagedApp } from "./install-files";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createInstallFixture(): Promise<{ root: string; oldPath: string; stagingPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "mados-installer-install-"));
  temporary.push(root);
  const oldPath = join(root, "current");
  const stagingPath = join(root, "staging");
  await mkdir(join(oldPath, "data"), { recursive: true });
  await mkdir(join(oldPath, "resources"), { recursive: true });
  await mkdir(stagingPath, { recursive: true });
  await writeFile(join(oldPath, "Mados Launcher.exe"), "old");
  await writeFile(join(oldPath, "data", "settings.db"), "keep this database");
  await writeFile(join(oldPath, "resources", "app.asar"), "old application resources");
  await writeFile(join(stagingPath, "Mados Launcher.exe"), "new");
  await writeFile(join(stagingPath, "app.asar"), "new application");
  await mkdir(join(stagingPath, "resources"), { recursive: true });
  await writeFile(join(stagingPath, "resources", "app.asar"), "new application resources");
  return { root, oldPath, stagingPath };
}

describe("installStagedApp", () => {
  it("never removes the current installation if moving it to backup fails", async () => {
    const { oldPath, stagingPath } = await createInstallFixture();
    await expect(installStagedApp(stagingPath, oldPath, { rename: async () => { throw new Error("locked"); } })).rejects.toThrow();
    expect(await readFile(join(oldPath, "Mados Launcher.exe"), "utf8")).toBe("old");
    expect(await readFile(join(oldPath, "data", "settings.db"), "utf8")).toBe("keep this database");
  });

  it("rolls back after the old installation was moved but committing staging fails", async () => {
    const { oldPath, stagingPath } = await createInstallFixture();
    await expect(installStagedApp(stagingPath, oldPath, { rename: async (from, to) => {
      if (from === stagingPath) throw new Error("commit failed");
      await rename(from, to);
    } })).rejects.toThrow();
    expect(await readFile(join(oldPath, "Mados Launcher.exe"), "utf8")).toBe("old");
  });

  it("refuses to replace an unrelated nonempty folder", async () => {
    const { root, stagingPath } = await createInstallFixture();
    const unrelated = join(root, "documents");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "personal.txt"), "keep");
    await expect(installStagedApp(stagingPath, unrelated)).rejects.toMatchObject({ code: "INSTALL_DIRECTORY" });
    expect(await readFile(join(unrelated, "personal.txt"), "utf8")).toBe("keep");
  });
  it("replaces application files, restores protected data, and creates a backup", async () => {
    const { oldPath, stagingPath, root } = await createInstallFixture();

    const result = await installStagedApp(stagingPath, oldPath);

    await expect(readFile(join(oldPath, "Mados Launcher.exe"), "utf8")).resolves.toBe("new");
    await expect(readFile(join(oldPath, "data", "settings.db"), "utf8")).resolves.toBe("keep this database");
    await expect(readFile(join(oldPath, "resources", "app.asar"), "utf8")).resolves.toBe("new application resources");
    await expect(readFile(join(oldPath, "app.asar"), "utf8")).resolves.toBe("new application");
    expect(result.executablePath).toBe(join(oldPath, "Mados Launcher.exe"));
    expect(result.backupPath).toBeTruthy();
    await expect(access(join(result.backupPath!, "Mados Launcher.exe"))).resolves.toBeUndefined();
    await expect(access(stagingPath)).rejects.toThrow();
    expect(result.backupPath!.startsWith(root)).toBe(true);
  });

  it("keeps the previous installation when staged content is invalid", async () => {
    const { oldPath, root } = await createInstallFixture();
    const invalidStaging = join(root, "invalid-staging");
    await mkdir(invalidStaging, { recursive: true });
    await writeFile(join(invalidStaging, "readme.txt"), "no executable");

    await expect(installStagedApp(invalidStaging, oldPath)).rejects.toMatchObject({ code: "INSTALL_EXECUTABLE" });
    await expect(readFile(join(oldPath, "Mados Launcher.exe"), "utf8")).resolves.toBe("old");
    await expect(readFile(join(oldPath, "data", "settings.db"), "utf8")).resolves.toBe("keep this database");
  });
});
