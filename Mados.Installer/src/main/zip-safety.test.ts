import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { validateArchiveEntry, extractArchive } from "./zip-safety";

const temporary: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mados-installer-zip-"));
  temporary.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("archive path safety", () => {
  it.each(["C:relative.txt", "file:stream", "CON.txt", "data/name.", "data/name "])("rejects Windows alias %s", (entry) => {
    expect(() => validateArchiveEntry(entry, false)).toThrow();
  });

  it("rejects a corrupted file instead of installing bytes with an invalid CRC", async () => {
    const directory = await tempDirectory();
    const archive = zipSync({ "Mados Launcher.exe": new TextEncoder().encode("executable") }, { level: 0 });
    archive[30 + "Mados Launcher.exe".length] ^= 1;
    const zipPath = join(directory, "corrupt.zip");
    await writeFile(zipPath, archive);
    await expect(extractArchive(zipPath, join(directory, "staging"), () => undefined)).rejects.toThrow();
  });
  it.each(["../escape.txt", "..\\escape.txt", "/absolute.txt", "\\absolute.txt", "C:\\absolute.txt"])("rejects unsafe entry %s", (entryName) => {
    expect(() => validateArchiveEntry(entryName, false)).toThrow();
  });

  it("rejects symlink entries and accepts a normal nested path", () => {
    expect(() => validateArchiveEntry("data/link", true)).toThrow();
    expect(validateArchiveEntry("resources/content/file.txt", false)).toBe("resources/content/file.txt");
  });

  it("extracts a valid archive into staging and reports extraction", async () => {
    const directory = await tempDirectory();
    const zipPath = join(directory, "release.zip");
    const stagingPath = join(directory, "staging");
    await writeFile(zipPath, zipSync({
      "Mados Launcher.exe": new TextEncoder().encode("executable"),
      "resources/content.txt": new TextEncoder().encode("content"),
    }));
    const stages: string[] = [];

    const executable = await extractArchive(zipPath, stagingPath, (stage) => stages.push(stage));

    expect(executable).toBe(join(stagingPath, "Mados Launcher.exe"));
    await expect(readFile(join(stagingPath, "resources/content.txt"), "utf8")).resolves.toBe("content");
    expect(stages).toEqual(["extracting"]);
  });

  it("rejects an archive that does not contain the launcher executable", async () => {
    const directory = await tempDirectory();
    const zipPath = join(directory, "release.zip");
    await writeFile(zipPath, zipSync({ "readme.txt": new TextEncoder().encode("missing app") }));

    await expect(extractArchive(zipPath, join(directory, "staging"), () => undefined)).rejects.toMatchObject({ code: "INSTALL_EXECUTABLE" });
  });
});
